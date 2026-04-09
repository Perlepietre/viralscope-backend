const express = require('express')
const cors = require('cors')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const supabase = require('./supabase')
require('dotenv').config()

const app = express()

app.use(cors())
app.use(express.json())

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'ViralScope backend running ✓' })
})

// ── CREA ABBONAMENTO STRIPE ──
app.post('/api/create-subscription', async (req, res) => {
  const { userId, email, name, paymentMethodId, priceId, plan, billing } = req.body

  try {
    // 1. Crea cliente Stripe
    const customer = await stripe.customers.create({
      email,
      name,
      payment_method: paymentMethodId,
      invoice_settings: { default_payment_method: paymentMethodId }
    })

    // 2. Crea abbonamento con trial 7 giorni
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      trial_period_days: 7,
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription'
      },
      expand: ['latest_invoice.payment_intent']
    })

    // 3. Salva in Supabase
    await supabase
      .from('profiles')
      .update({
        stripe_customer_id: customer.id,
        stripe_subscription_id: subscription.id,
        plan,
        billing,
        status: 'trial',
        trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      })
      .eq('id', userId)

    res.json({ success: true, subscriptionId: subscription.id })

  } catch (err) {
    console.error('Stripe error:', err)
    res.status(400).json({ message: err.message })
  }
})

// ── WEBHOOK STRIPE ──
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    return res.status(400).json({ message: 'Webhook error: ' + err.message })
  }

  // Gestisci gli eventi Stripe
  switch (event.type) {

    case 'customer.subscription.trial_will_end':
      // Trial sta per scadere — invia email reminder (step 7)
      console.log('Trial ending soon for:', event.data.object.customer)
      break

    case 'invoice.payment_succeeded':
      // Pagamento riuscito — attiva abbonamento
      const invoice = event.data.object
      if (invoice.billing_reason === 'subscription_cycle') {
        await supabase
          .from('profiles')
          .update({ status: 'active' })
          .eq('stripe_customer_id', invoice.customer)
        console.log('Subscription activated for:', invoice.customer)
      }
      break

    case 'customer.subscription.deleted':
      // Abbonamento cancellato
      await supabase
        .from('profiles')
        .update({ status: 'cancelled' })
        .eq('stripe_customer_id', event.data.object.customer)
      console.log('Subscription cancelled for:', event.data.object.customer)
      break
  }

  res.json({ received: true })
})

// ── TRACK ACCOUNT (chiama Apify) ──
app.post('/api/track-account', async (req, res) => {
  const { userId, handle, platform } = req.body

  try {
    const { ApifyClient } = require('apify-client')
    const client = new ApifyClient({ token: process.env.APIFY_API_KEY })

    // Scegli lo scraper giusto per piattaforma
    const actorId = platform === 'ig'
      ? 'apify/instagram-scraper'
      : 'clockworks/free-tiktok-scraper'

    const input = platform === 'ig'
      ? { usernames: [handle.replace('@', '')], resultsLimit: 30 }
      : { profiles: [handle.replace('@', '')], resultsPerPage: 30 }

    // Lancia scraper Apify
    const run = await client.actor(actorId).call(input)
    const { items } = await client.dataset(run.defaultDatasetId).listItems()

    if (!items || !items.length) {
      return res.status(404).json({ message: 'Account not found or no posts available.' })
    }

    // Calcola viral score
    const views = items.map(p => p.videoPlayCount || p.likesCount || 0).filter(v => v > 0)
    const avgViews = views.length > 0 ? views.reduce((a, b) => a + b, 0) / views.length : 1

    const posts = items.map(p => {
      const v = p.videoPlayCount || p.likesCount || 0
      return {
        user_id: userId,
        handle: handle,
        platform: platform,
        post_id: p.id || p.shortCode,
        caption: p.caption || p.text || '',
        views: v,
        likes: p.likesCount || 0,
        comments: p.commentsCount || 0,
        viral_score: avgViews > 0 ? Math.round((v / avgViews) * 10) / 10 : 0,
        thumbnail_url: p.displayUrl || p.covers?.[0] || '',
        post_url: p.url || '',
        posted_at: p.timestamp || p.createTime || new Date().toISOString(),
        created_at: new Date().toISOString()
      }
    })

    // Salva in Supabase
    await supabase.from('tracked_posts').upsert(posts, { onConflict: 'post_id' })

    // Salva account tracciato
    await supabase.from('tracked_accounts').upsert({
      user_id: userId,
      handle: handle,
      platform: platform,
      followers: items[0]?.followersCount || 0,
      avg_views: Math.round(avgViews),
      last_updated: new Date().toISOString()
    }, { onConflict: 'user_id,handle' })

    res.json({ success: true, posts: posts.length, avgViews: Math.round(avgViews) })

  } catch (err) {
    console.error('Track error:', err)
    res.status(500).json({ message: err.message })
  }
})

// ── GET TRACKED ACCOUNTS ──
app.get('/api/accounts/:userId', async (req, res) => {
  const { data, error } = await supabase
    .from('tracked_accounts')
    .select('*')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ message: error.message })
  res.json(data)
})

// ── GET POSTS FOR ACCOUNT ──
app.get('/api/posts/:userId/:handle', async (req, res) => {
  const { data, error } = await supabase
    .from('tracked_posts')
    .select('*')
    .eq('user_id', req.params.userId)
    .eq('handle', decodeURIComponent(req.params.handle))
    .order('viral_score', { ascending: false })

  if (error) return res.status(500).json({ message: error.message })
  res.json(data)
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`ViralScope backend running on port ${PORT}`))

module.exports = app