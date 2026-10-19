# bt-gateway

Nginx edge for BharatTruck. Every app reaches the backend only through here
(`NEXT_PUBLIC_API_URL`); each `/api/<area>/` prefix is rewritten and proxied to one service.

**`nginx.conf` is the routing table.** It is one file, it is read top-to-bottom, and it is the thing
that actually runs — read it instead of a copy. The previous version of this README duplicated the
route list and drifted (it never gained `/api/tracking/`, and still said the service deployed to
Render). Upstreams are `$*_upstream` variables resolved from `*_SERVICE_URL` env at request time, so
the env var names are in that file too.

Deploy: GCP Cloud Run, `asia-south1`, via `.github/workflows/deploy.yml` — see `.github/workflows/README.md`.
Local: `docker compose up bt-gateway` from the repo root.
