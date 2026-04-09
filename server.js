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
    let posts = []
    if (platform === 'ig') {
      const run = await client.actor('apify/instagram-scraper').call({ usernames: [handle.replace('@','')], resultsLimit: 30 })
      const { items } = await client.dataset(run.defaultDatasetId).listItems()
      posts = items.map(p => ({ platform:'ig', post_id:p.id||p.shortCode, handle:handle.replace('@',''), caption:p.caption||'', views:p.videoViewCount||p.likesCount||0, likes:p.likesCount||0, comments:p.commentsCount||0, published_at:p.timestamp, thumbnail:p.displayUrl||'' }))
    }
    if (platform === 'tt') {
      const run = await client.actor('clockworks/tiktok-scraper').call({ profiles: [handle.replace('@','')], resultsPerPage: 30 })
      const { items } = await client.dataset(run.defaultDatasetId).listItems()
      posts = items.map(p => ({ platform:'tt', post_id:p.id, handle:handle.replace('@',''), caption:p.text||'', views:p.playCount||0, likes:p.diggCount||0, comments:p.commentCount||0, published_at:p.createTime, thumbnail:p.covers?.[0]||'' }))
    }
    const avgViews = posts.reduce((s,p) => s+p.views, 0) / (posts.length||1)
    const postsWithScore = posts.map(p => ({ ...p, user_id:userId, viral_score: avgViews>0 ? Math.round((p.views/avgViews)*10)/10 : 0 }))
    await sb.from('tracked_accounts').upsert({ user_id:userId, handle:handle.replace('@',''), platform, updated_at:new Date().toISOString() }, { onConflict:'user_id,handle,platform' })
    if (postsWithScore.length) await sb.from('posts').upsert(postsWithScore, { onConflict:'post_id' })
    res.status(200).json({ success:true, posts_count:postsWithScore.length, avg_views:Math.round(avgViews), top_score:postsWithScore.length?Math.max(...postsWithScore.map(p=>p.viral_score)):0 })
  } catch(err) {
    console.error(err)
    res.status(500).json({ message: err.message })
  }
})

app.post('/api/create-subscription', async (req, res) => {
  const { userId, email, name, paymentMethodId, priceId, plan, billing } = req.body
  try {
    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const customer = await stripe.customers.create({ email, name, payment_method:paymentMethodId, invoice_settings:{ default_payment_method:paymentMethodId } })
    const subscription = await stripe.subscriptions.create({ customer:customer.id, items:[{ price:priceId }], trial_period_days:7 })
    await sb.from('profiles').update({ stripe_customer_id:customer.id, stripe_subscription_id:subscription.id, status:'trial', plan, billing }).eq('id', userId)
    res.status(200).json({ success:true, subscriptionId:subscription.id })
  } catch(err) {
    res.status(500).json({ message: err.message })
  }
})

app.post('/api/stripe-webhook', express.raw({ type:'application/json' }), async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)
    if (event.type === 'invoice.payment_succeeded') await sb.from('profiles').update({ status:'active' }).eq('stripe_customer_id', event.data.object.customer)
    if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') await sb.from('profiles').update({ status:'cancelled' }).eq('stripe_customer_id', event.data.object.customer)
    res.status(200).json({ received:true })
  } catch(err) {
    res.status(400).json({ message: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('ViralScope backend running on port ' + PORT))
