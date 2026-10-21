// Services route without the /api prefix (docs/09 §3); the query string lives in event.request.querystring.
function stripApi(uri) {
  if (uri === '/api') return '/';
  if (uri.startsWith('/api/')) return uri.slice(4);
  return uri;
}

function handler(event) {
  var request = event.request;
  request.uri = stripApi(request.uri);
  return request;
}
