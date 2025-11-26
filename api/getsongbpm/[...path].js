const API_BASE = 'https://api.getsongbpm.com';

export default async function handler(request, response) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return response.status(200).end();
  }

  // Get the path from the URL
  const { path } = request.query;
  const pathString = Array.isArray(path) ? path.join('/') : path || '';
  
  // Build query string from remaining params (excluding 'path')
  const queryParams = new URLSearchParams();
  Object.entries(request.query).forEach(([key, value]) => {
    if (key !== 'path') {
      queryParams.append(key, value);
    }
  });
  
  const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
  const targetUrl = `${API_BASE}/${pathString}${queryString}`;

  try {
    const fetchResponse = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    });

    const data = await fetchResponse.text();

    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'public, max-age=86400');
    
    return response.status(fetchResponse.status).send(data);
  } catch (error) {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Access-Control-Allow-Origin', '*');
    return response.status(500).json({ error: 'Proxy error', message: error.message });
  }
}
