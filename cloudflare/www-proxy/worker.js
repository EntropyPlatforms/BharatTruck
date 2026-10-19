// www.bharattruck.net → bt-app on Cloud Run (2026-10-19).
//
// Cloud Run domain mappings are not offered in asia-south1, and a Google load balancer
// costs money every month, so the public domain is served by this Cloudflare Worker: it
// forwards every request to the bt-app service and passes the answer back. The bare
// domain bharattruck.net redirects to www.
//
// Deploy: Cloudflare dashboard → Workers & Pages → bharattruck → Edit code → paste → Deploy,
// then Settings → Domains & Routes → add Custom domains www.bharattruck.net and bharattruck.net.
// No secrets live here; the app's API calls go straight to the gateway, which allows this
// origin (bt-gateway/nginx.conf.template, the $cors_origin map).

const APP_ORIGIN = 'https://bt-app-itcdoenefa-el.a.run.app'
const PUBLIC_HOST = 'www.bharattruck.net'

export default {
  async fetch(request) {
    const url = new URL(request.url)

    // Bare domain and plain http → the one canonical address.
    if (url.hostname !== PUBLIC_HOST || url.protocol !== 'https:') {
      url.hostname = PUBLIC_HOST
      url.protocol = 'https:'
      url.port = ''
      return Response.redirect(url.toString(), 301)
    }

    const upstream = new URL(url.pathname + url.search, APP_ORIGIN)
    const headers = new Headers(request.headers)
    headers.delete('host') // fetch() sets the Cloud Run host itself
    headers.set('x-forwarded-host', PUBLIC_HOST)
    headers.set('x-forwarded-proto', 'https')

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const res = await fetch(upstream, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual', // pass the app's own redirects (e.g. to /login) back to the browser
    })

    // A redirect that names the Cloud Run address is pointed back at the public domain,
    // so a visitor never lands on the run.app URL.
    const out = new Response(res.body, res)
    const location = out.headers.get('location')
    if (location && location.startsWith(APP_ORIGIN)) {
      out.headers.set('location', `https://${PUBLIC_HOST}${location.slice(APP_ORIGIN.length)}`)
    }
    return out
  },
}
