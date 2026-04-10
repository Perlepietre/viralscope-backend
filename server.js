const express = require('express')
const app = express()

app.use(express.json())
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  next()
})

app.get('/', (req, res) => {
  res.json({ status: 'ViralScope backend running ok' })
})

// ── TRACK ACCOUNT ──────────────────────────────────────────────
app.post('/api/track-account', async (req, res) => {
  const { handle, platform, userId } = req.body
  if (!handle || !platform || !userId) {
    return res.status(400).json({ message: 'Missing required fields' })
  }
  try {
    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { ApifyClient } = require('apify-client')
    const client = new ApifyClient({ token: process.env.APIFY_API_KEY })
    const cleanHandle = handle.replace('@', '')
    let rawPosts = []
    let followers = 0

    if (platform === 'ig') {
      // Step 1: prendi i dati del profilo (followers)
      const profileRun = await client.actor('apify/instagram-profile-scraper').call({
        usernames: [cleanHandle]
      })
      const { items: profileItems } = await client.dataset(profileRun.defaultDatasetId).listItems()
      if (profileItems.length > 0) {
        followers = profileItems[0].followersCount || 0
      }

      // Step 2: prendi i post con instagram-post-scraper
      const postsRun = await client.actor('apify/instagram-post-scraper').call({
        username: [cleanHandle],
        resultsLimit: 30
      })
      const { items: postItems } = await client.dataset(postsRun.defaultDatasetId).listItems()
      rawPosts = postItems.map(p => ({
        post_id: p.shortCode || p.id,
        caption: p.caption || '',
        views: p.videoViewCount || p.videoPlayCount || p.likesCount || 0,
        likes: p.likesCount || 0,
        comments: p.commentsCount || 0,
        published_at: p.timestamp || null,
        thumbnail: p.displayUrl || p.thumbnailUrl || ''
      }))
    }

    if (platform === 'tt') {
      const run = await client.actor('clockworks/free-tiktok-scraper').call({
        profiles: [cleanHandle],
        resultsPerPage: 30,
        maxProfilesPerQuery: 1
      })
      const { items } = await client.dataset(run.defaultDatasetId).listItems()
      const profileItem = items.find(i => i.authorMeta?.fans !== undefined)
      const postItems = items.filter(i => i.id && (i.videoMeta || i.playCount !== undefined))
      followers = profileItem?.authorMeta?.fans || 0
      rawPosts = postItems.map(p => ({
        post_id: p.id,
        caption: p.text || '',
        views: p.playCount || p.diggCount || 0,
        likes: p.diggCount || 0,
        comments: p.commentCount || 0,
        published_at: p.createTime ? new Date(p.createTime * 1000).toISOString() : null,
        thumbnail: p.videoMeta?.coverUrl || p.covers?.[0] || ''
      }))
    }

    if (!rawPosts.length) {
      return res.status(404).json({ message: 'No posts found. Check username and make sure the account is public.' })
    }

    const views = rawPosts.map(p => p.views).filter(v => v > 0)
    const avgViews = views.length ? views.reduce((a, b) => a + b, 0) / views.length : 1

    const posts = rawPosts.map(p => ({
      user_id: userId,
      handle: handle,
      platform: platform,
      post_id: p.post_id,
      caption: p.caption,
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      viral_score: avgViews > 0 ? Math.round((p.views / avgViews) * 10) / 10 : 0,
      thumbnail: p.thumbnail,
      published_at: p.published_at,
      saved: false,
      created_at: new Date().toISOString()
    }))

    const topScore = Math.max(...posts.map(p => p.viral_score))

    const { error: postsError } = await sb.from('tracked_posts').upsert(posts, { onConflict: 'post_id' })
    if (postsError) throw new Error('Posts error: ' + postsError.message)

    const { error: accError } = await sb.from('tracked_accounts').upsert({
      user_id: userId,
      handle: handle,
      platform: platform,
      followers: followers,
      avg_views: Math.round(avgViews),
      top_viral_score: topScore,
      last_updated: new Date().toISOString(),
      created_at: new Date().toISOString()
    }, { onConflict: 'user_id,handle' })
    if (accError) throw new Error('Account error: ' + accError.message)

    res.status(200).json({
      success: true,
      posts_count: posts.length,
      avg_views: Math.round(avgViews),
      top_score: topScore,
      followers: followers
    })

  } catch (err) {
    console.error('track-account error:', err)
    res.status(500).json({ message: err.message })
  }
})

// ── CREATE SUBSCRIPTION ────────────────────────────────────────
app.post('/api/create-subscription', async (req, res) => {
  const { userId, email, name, paymentMethodId, priceId, plan, billing } = req.body
  try {
    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const customer = await stripe.customers.create({
      email, name,
      payment_method: paymentMethodId,
      invoice_settings: { default_payment_method: paymentMethodId }
    })
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      trial_period_days: 7
    })
    await sb.from('profiles').update({
      stripe_customer_id: customer.id,
      stripe_subscription_id: subscription.id,
      status: 'trial', plan, billing
    }).eq('id', userId)
    res.status(200).json({ success: true, subscriptionId: subscription.id })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

// ── STRIPE WEBHOOK ─────────────────────────────────────────────
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    )
    if (event.type === 'invoice.payment_succeeded')
      await sb.from('profiles').update({ status: 'active' }).eq('stripe_customer_id', event.data.object.customer)
    if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted')
      await sb.from('profiles').update({ status: 'cancelled' }).eq('stripe_customer_id', event.data.object.customer)
    res.status(200).json({ received: true })
  } catch (err) {
    res.status(400).json({ message: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('ViralScope backend running on port ' + PORT))
