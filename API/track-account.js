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
    const cleanHandle = handle.replace('@', '')
    let rawPosts = []
    let followers = 0

    // ── INSTAGRAM ──────────────────────────────────────────
    if (platform === 'ig') {
      const run = await client.actor('apify/instagram-scraper').call({
        usernames: [cleanHandle],
        resultsLimit: 30,
        scrapeType: 'posts'
      })
      const { items } = await client.dataset(run.defaultDatasetId).listItems()

      // The scraper returns mixed results: profile info + posts
      // Profile item has followersCount but no shortCode
      const profileItem = items.find(i => i.followersCount !== undefined)
      const postItems   = items.filter(i => i.shortCode || i.id)

      followers = profileItem?.followersCount || 0

      rawPosts = postItems.map(p => ({
        platform:     'ig',
        post_id:      p.shortCode || p.id,
        handle:       handle,
        caption:      p.caption || '',
        views:        p.videoViewCount || p.videoPlayCount || p.likesCount || 0,
        likes:        p.likesCount || 0,
        comments:     p.commentsCount || 0,
        published_at: p.timestamp || null,
        thumbnail:    p.displayUrl || p.thumbnailUrl || ''
      }))
    }

    // ── TIKTOK ─────────────────────────────────────────────
    if (platform === 'tt') {
      const run = await client.actor('clockworks/free-tiktok-scraper').call({
        profiles:       [cleanHandle],
        resultsPerPage: 30,
        maxProfilesPerQuery: 1
      })
      const { items } = await client.dataset(run.defaultDatasetId).listItems()

      const profileItem = items.find(i => i.authorMeta?.fans !== undefined)
      const postItems   = items.filter(i => i.id && i.videoMeta)

      followers = profileItem?.authorMeta?.fans || 0

      rawPosts = postItems.map(p => ({
        platform:     'tt',
        post_id:      p.id,
        handle:       handle,
        caption:      p.text || '',
        views:        p.playCount || p.diggCount || 0,
        likes:        p.diggCount || 0,
        comments:     p.commentCount || 0,
        published_at: p.createTime ? new Date(p.createTime * 1000).toISOString() : null,
        thumbnail:    p.videoMeta?.coverUrl || p.covers?.[0] || ''
      }))
    }

    if (!rawPosts.length) {
      return res.status(404).json({
        message: 'Account not found or has no public posts. Make sure the username is correct.'
      })
    }

    // ── VIRAL SCORE CALCULATION ────────────────────────────
    // Score = post_views / avg_views_of_account
    // A score of 5x means this post got 5x the account's average
    const viewsList = rawPosts.map(p => p.views).filter(v => v > 0)
    const avgViews  = viewsList.length > 0
      ? viewsList.reduce((a, b) => a + b, 0) / viewsList.length
      : 1

    const posts = rawPosts.map(p => ({
      user_id:      userId,
      handle:       handle,
      platform:     platform,
      post_id:      p.post_id,
      caption:      p.caption,
      views:        p.views,
      likes:        p.likes,
      comments:     p.comments,
      viral_score:  avgViews > 0 ? Math.round((p.views / avgViews) * 10) / 10 : 0,
      thumbnail:    p.thumbnail,
      published_at: p.published_at,
      saved:        false,
      created_at:   new Date().toISOString()
    }))

    const topViralScore = Math.max(...posts.map(p => p.viral_score))

    // ── SAVE POSTS TO SUPABASE ─────────────────────────────
    const { error: postsError } = await supabase
      .from('tracked_posts')
      .upsert(posts, { onConflict: 'post_id' })

    if (postsError) {
      console.error('Supabase posts error:', postsError)
      return res.status(500).json({ message: 'Failed to save posts: ' + postsError.message })
    }

    // ── SAVE / UPDATE TRACKED ACCOUNT ─────────────────────
    const { error: accountError } = await supabase
      .from('tracked_accounts')
      .upsert({
        user_id:         userId,
        handle:          handle,
        platform:        platform,
        followers:       followers,
        avg_views:       Math.round(avgViews),
        top_viral_score: topViralScore,
        last_updated:    new Date().toISOString(),
        created_at:      new Date().toISOString()
      }, { onConflict: 'user_id,handle' })

    if (accountError) {
      console.error('Supabase account error:', accountError)
      return res.status(500).json({ message: 'Failed to save account: ' + accountError.message })
    }

    // ── SUCCESS ────────────────────────────────────────────
    return res.status(200).json({
      success:         true,
      posts_count:     posts.length,
      avg_views:       Math.round(avgViews),
      top_viral_score: topViralScore,
      followers:       followers
    })

  } catch (err) {
    console.error('Track account error:', err)
    return res.status(500).json({ message: err.message || 'Internal server error' })
  }
}
