# AWS deployment runbook

> **Status: written and rehearsed locally, not deployed.** No AWS account was
> used in this project. Everything below that does not need one has been run:
> the production compose override (`docker-compose.prod.yml`) boots with
> registry-named images on ports 80/443 and passes the smoke and browser tests;
> scaling to three instances and back is tested on every CI run
> (`npm run stack:scale`); CI publishes the images. The AWS steps are the plan
> for when an account exists. Do not describe this project as "deployed on AWS"
> until they have been carried out.

The spec's target (§40):

```
Internet → AWS / Nginx → Load Balancer → EC2 #1 / EC2 #2 → Redis → PostgreSQL
```

Two steps, as the spec suggests: one server first, then the multi-instance
setup that proves horizontal scaling.

## What is already in place

| Piece                | Where                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Images               | CI's `publish` job pushes `ghcr.io/<owner>/<repo>/{backend,migrate,web}:<sha>` and `:latest` after all tests pass on `main` |
| Single-server layout | `docker-compose.prod.yml` (registry images, ports 80/443, Let's Encrypt, databases not published)                           |
| HTTPS                | Nginx: TLS 1.2/1.3, HTTP→HTTPS redirect, HSTS for real host names, ACME webroot on port 80                                  |
| Scaling              | one `backend` service with replicas; Nginx discovers them through DNS                                                       |
| Health               | `/healthz` (liveness), `/readyz` (readiness, `draining` on shutdown)                                                        |
| Graceful shutdown    | SIGTERM → sockets closed with 4008 → documents flushed → exit in ~2 s                                                       |

## Before you start

1. Create the AWS account and immediately add a **billing alarm** (Billing →
   Budgets → a monthly budget with an email alert). Free-tier and credit terms
   for new accounts change over time; check the current ones rather than
   assuming anything is free.
2. Pick one region and use it for everything.
3. Make the GHCR packages readable by the server: either make them public
   (GitHub → Packages → package settings), or create a GitHub token with
   `read:packages` and `docker login ghcr.io` on the server.
4. A domain name is optional for a first test (a raw IP works over HTTP only),
   but HTTPS with a trusted certificate needs one. Any registrar works; point an
   `A` record at the server (step 1) or a `CNAME`/alias at the load balancer
   (step 2).

## Step 1 — one EC2 instance (everything on it)

```
Internet ──► EC2 (Docker): nginx :80/:443 ─► backend ×2 ─► redis, postgres (same host)
```

1. **Launch** an EC2 instance: Ubuntu 24.04 LTS, `t3.small` (2 GB RAM), 20 GB
   gp3 disk. Measured locally, the whole stack idles at about 110 MB (two
   backends ~33 MB each, PostgreSQL ~21 MB, Nginx ~19 MB, Redis ~4 MB); the
   headroom is for open documents, connections and the operating system.
2. **Security group:** inbound 80 and 443 from anywhere; 22 from _your_ IP only.
   Nothing else. PostgreSQL and Redis are not published by the prod override,
   so they are reachable only inside Docker.
3. **Install Docker** (Docker's apt repository, then
   `sudo usermod -aG docker ubuntu`).
4. **Get the files** the server needs: `docker-compose.yml`,
   `docker-compose.prod.yml` and a `.env` (copy `.env.example`, set real
   `JWT_SECRET`, `JWT_REFRESH_SECRET`, `POSTGRES_PASSWORD`; never commit it).
   `git clone` works too; only those three files are used.
5. **Certificate** (needs the domain's DNS to point at the instance):
   ```bash
   sudo mkdir -p /var/www/acme
   # First issue, before Nginx runs: certbot's own temporary web server on :80.
   sudo certbot certonly --standalone -d editor.example.com
   ```
   Renewal later uses the webroot Nginx serves on port 80, then reloads Nginx:
   ```bash
   sudo certbot renew --webroot -w /var/www/acme \
     --deploy-hook "docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app restart nginx"
   ```
   (`certbot` installs a timer that runs renewal twice a day.)
6. **Start:**
   ```bash
   export DOMAIN=editor.example.com
   export IMAGE_PREFIX=ghcr.io/<owner>/<repo>
   export IMAGE_TAG=<git sha from the green CI run>   # or latest
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --wait
   ```
7. **Verify** from your machine, against the real URL:
   ```bash
   STACK_URL=https://editor.example.com npm run stack:smoke
   STACK_URL=https://editor.example.com npm run stack:e2e
   ```
   (The browser test's instance check reads `docker compose logs`, so run it
   with `SKIP_INSTANCE_CHECK=1` from a machine that is not the server.)
8. **Deploy a new version:** set `IMAGE_TAG` to the new commit and run the same
   `up -d --wait`. Compose replaces the backend replicas; each old one shuts down
   gracefully and its users reconnect to the other (tested by
   `npm run stack:scale` and `stack:resilience`). The `migrate` service runs
   before the new backends start.

What step 1 does **not** give: tolerance of the machine failing. One host is a
single point of failure; step 2 removes it for the app tier.

## Step 2 — load balancer + two EC2 instances + managed data

```
Internet ─► ALB (HTTPS, ACM certificate) ─┬─► EC2 #1: nginx ─► backend ×N ─┐
                                          └─► EC2 #2: nginx ─► backend ×N ─┤
                                                     ElastiCache Redis ◄────┤
                                                     RDS PostgreSQL ◄───────┘
```

| Component            | Choice                                                                                                    | Notes                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Load balancer        | Application Load Balancer, HTTPS listener with an ACM certificate, HTTP listener redirecting to HTTPS     | ALBs support WebSockets natively                                                        |
| Target group         | the EC2 instances, port 80 (Nginx), health check `GET /readyz` expecting 200                              | `/readyz` turns 503 on dependency loss and while draining                               |
| Idle timeout         | 60 s default is enough: the server pings every 30 s                                                       | raise only together with the heartbeat                                                  |
| Deregistration delay | ~30 s (default 300 s)                                                                                     | how long the ALB waits for an instance to drain; our shutdown takes ~2 s                |
| Stickiness           | **off**                                                                                                   | any instance serves any document; reconnecting clients re-sync                          |
| App servers          | 2 × EC2 in different Availability Zones, running only `nginx` + `backend`                                 | `postgres`/`redis` services not started there                                           |
| PostgreSQL           | RDS for PostgreSQL 17, Multi-AZ for real use                                                              | `DATABASE_URL` points at the RDS endpoint                                               |
| Redis                | ElastiCache for Redis 7, cluster mode **disabled**                                                        | Pub/Sub on one primary; Redis holds no durable state, so a failover only costs a resync |
| Secrets              | SSM Parameter Store or Secrets Manager, read into the environment at start                                | instead of a `.env` file on disk                                                        |
| Migrations           | run the `migrate` image once per deploy (one instance, or a one-off task) before updating the app servers | never from every instance                                                               |

Configuration differences from step 1:

- **`TRUST_PROXY_HOPS=2`**: the ALB and Nginx each append to `X-Forwarded-For`,
  so the client is the second entry from the right. With the wrong value, rate
  limits either count the ALB as the client or trust client-written addresses
  (see [security.md](security.md)).
- TLS ends at the ALB; Nginx on the instances can listen on 80 only (the ALB's
  HTTP→HTTPS redirect covers browsers) and HSTS is added by the ALB or kept in
  Nginx keyed on `X-Forwarded-Proto`.
- `CLIENT_URL=https://<domain>` on every instance.

How to show that it scales (the point of the phase): two instances in the
target group, two browsers, check in each instance's logs which one served which
user (as `stack:e2e` does), stop one instance and keep typing, then add a third
instance to the target group and watch new sockets arrive on it.

## Teardown (to stop paying)

Delete in this order: Auto Scaling group or instances, ALB and target group,
RDS instance (take a final snapshot if wanted), ElastiCache cluster, NAT
gateways or Elastic IPs if created, then check the billing dashboard the next
day.

## Why not ECS, Kubernetes or Lambda

The spec says "start simple", and Kubernetes is explicitly out of scope. EC2 +
Docker Compose runs exactly the images and compose files tested locally and in
CI, so nothing new can break on the way. ECS would be the next step if the
number of servers grew; Lambda does not fit long-lived WebSockets with
in-memory documents.
