export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  const key = process.env.GOOGLE_MAPS_KEY || '';
  res.status(200).send(`window.LOCOCAM_CONFIG = window.LOCOCAM_CONFIG || {}; window.LOCOCAM_CONFIG.GOOGLE_MAPS_KEY = window.LOCOCAM_CONFIG.GOOGLE_MAPS_KEY || '${key}';`);
}
