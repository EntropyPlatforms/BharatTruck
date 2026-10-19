# BUILD CONTEXT IS THE REPO ROOT (docker build -f bt-gateway/Dockerfile .), so COPY sources
# are repo-relative — uniform with the other services, which build this way via cloudbuild.yaml.
FROM nginx:alpine

RUN rm /etc/nginx/conf.d/default.conf

COPY bt-gateway/nginx.conf.template /etc/nginx/nginx.conf.template
COPY bt-gateway/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV DNS_RESOLVER=127.0.0.11
ENV AUTH_SERVICE_URL=http://bt-auth-service:3001
ENV BOOKING_SERVICE_URL=http://bt-booking-service:3002
ENV PRICING_SERVICE_URL=http://bt-pricing-service:3003
ENV PAYMENT_SERVICE_URL=http://bt-payment-service:3004
ENV CARGO_SERVICE_URL=http://bt-cargo-ledger:3005
ENV FLEET_SERVICE_URL=http://bt-fleet-service:3007
ENV TRACKING_SERVICE_URL=http://bt-tracking-service:3006
ENV CORS_ALLOWED_ORIGINS=*

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
