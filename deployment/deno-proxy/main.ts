Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    return new Response('OK', { status: 200 });
  }

  // /proxy/blossom.nostr.build/upload → https://blossom.nostr.build/upload
  if (url.pathname.startsWith('/proxy/')) {
    const [, , server, ...rest] = url.pathname.split('/');
    const targetUrl = `https://${server}/${rest.join('/')}`;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': 'https://noornote.app',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    // Add CORS headers to response
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', 'https://noornote.app');

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  return new Response('Not Found', { status: 404 });
});
