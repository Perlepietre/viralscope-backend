const supabase = require('../supabase')
const { ApifyClient } = require('apify-client')
require('dotenv').config()

module.exports = async (req, res) => {
 res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' })
  }

  const { handle, platform, userId } = req.body

  if (!handle || !platform || !userId) {
    return res.status(400).json({ message: 'Missing required fields' })
  }

  try {
    const client = new ApifyClient({ token: process.env.APIFY_API_KEY })

    let posts = []

    if (platform === 'ig') {
      // Instagram scraper
      const run = await client.actor('apify/instagram-scraper').call({
        usernames: [handle.replace('@', '')],
        resultsLimit: 30
      })
      const { items } = await client.dataset(run.defaultDatasetId).listItems()
      posts = items.map(p => ({
        platform: 'ig',
        post_id: p.id || p.shortCode,
        handle: handle,
        caption: p.caption || '',
        views: p.videoViewCount || p.likesCount || 0,
        likes: p.likesCount || 0,
        comments: p.commentsCount || 0,
        published_at: p.timestamp,
        thumbnail: p.displayUrl || ''
      }))
    }

    if (platform === 'tt') {
      // TikTok scraper
      const run = await client.actor('clockworks/tiktok-scraper').call({
        profile