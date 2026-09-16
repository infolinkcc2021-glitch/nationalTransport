# National Transport PLC — Backend API

FastAPI + SQLite backend for the National Transport fleet system.
Handles vehicles, drivers, trips, customer orders, GPS settings and user accounts
(admin + customers).

## Requirements

- Python 3.12+ (tested on 3.14)
- `pip install -r requirements.txt`

## Quick start

```powershell
# first time (installs FastAPI, uvicorn, PyJWT)
pip install -r requirements.txt

# run the server (seeds the DB automatically on first run)
.\run.bat        # or: .\run.ps1
```

The API is then available at:

- API base: `http://127.0.0.1:8000/api`
- Interactive docs: `http://127.0.0.1:8000/docs`
- Health check: `http://127.0.0.1:8000/api/health`

## Demo accounts

| Role     | Username  | Password      |
| -------- | --------- | ------------- |
| Admin    | `admin`   | `admin123`    |
| Customer | `customer`| `customer123` |

Change these in production (`backend/app/seed.py` and set `NTP_JWT_SECRET`).

## Database

SQLite file: `backend/data/ntp.db` (created automatically).

- `python -m app.seed`          — seed only if empty
- `python -m app.seed --force`  — wipe and re-seed (114 vehicles, 114 drivers, 154 trips)

Fleet roster is imported from `fleet-list.csv` at the project root (Truck No, Trailer No,
Driver, Phone, Fayda No).

## API overview

| Method | Path                  | Access                     | Purpose                        |
| ------ | --------------------- | -------------------------- | ------------------------------ |
| POST   | `/api/auth/register`  | public                     | create customer account        |
| POST   | `/api/auth/login`     | public                     | get JWT + user                 |
| GET    | `/api/auth/me`        | any logged-in user         | current user                   |
| GET    | `/api/vehicles`       | public                     | list vehicles                  |
| POST   | `/api/vehicles`       | admin                      | add vehicle                    |
| PUT    | `/api/vehicles`       | admin (or empty DB)        | bulk replace (sync)            |
| PUT    | `/api/vehicles/{id}`  | admin                      | update vehicle                 |
| DELETE | `/api/vehicles/{id}`  | admin                      | delete vehicle                 |
| …      | `/api/drivers`        | same pattern as vehicles   | drivers                        |
| …      | `/api/trips`          | same pattern as vehicles   | trips                          |
| GET    | `/api/orders`         | admin                      | all orders                     |
| GET    | `/api/orders/mine`    | any logged-in user         | caller's own orders            |
| GET    | `/api/orders/{id}`    | public                     | track by reference             |
| POST   | `/api/orders`         | any logged-in user         | create order (fleet assigned)  |
| PUT    | `/api/orders`         | admin (or empty DB)        | bulk replace (sync)            |
| PUT    | `/api/orders/{id}`    | admin                      | update order                   |
| PATCH  | `/api/orders/{id}/status` | admin                  | set order status               |
| DELETE | `/api/orders/{id}`    | admin                      | delete order                   |
| GET    | `/api/gps`            | admin                      | read GPS settings              |
| PUT    | `/api/gps`            | admin                      | save GPS settings              |

Auth header: `Authorization: Bearer <token>`

## How the website connects

`js/api.js` (loaded on every page) does this at startup:

1. `GET /api/health` — if unreachable, the site keeps working fully **offline** in localStorage mode.
2. `GET /api/vehicles` etc. — if the server has data, it pulls it into localStorage (server is authoritative).
3. If the server database is empty, it pushes the browser's current data to seed it (bootstrap).
4. Admin saves (vehicles/drivers/trips/orders/GPS) are pushed to the server automatically.

Notes:

- Admin edits are only pushed when signed in as **admin**.
- Customer orders are created through `POST /api/orders` when signed in, so they
  appear in the database and the customer's "My Shipments" list.

## Security notes

- Passwords: PBKDF2-SHA256, salted (stdlib `hashlib`).
- Tokens: JWT (HS256), 7-day expiry, secret via `NTP_JWT_SECRET` env var.
- CORS is open (`*`) for local intranet use — restrict `allow_origins` in
  `backend/app/main.py` before exposing publicly.
