-- ============================================================================
-- BharatTruck demo scenario seed  (2026-07-20)
-- Safe to run in the Supabase SQL editor. Wrapped in a transaction.
--
-- What it does:
--   1. Clears ONLY the BharatTruck transactional tables (bookings/quotes/etc).
--      It does NOT touch: users, drivers, or ANY pmo_* table (separate app).
--   2. Creates 5 named users (loginable, bcrypt cost-12) + 3 driver rows.
--   3. Seeds a logical end-to-end set: 1 paid trip, 1 in-transit trip with a
--      GPS trail, 1 open auction with 3 bids, 1 direct request awaiting the
--      driver, and a second shipper's auction.
--
-- Logins created (email / password):
--   aditya@bharattruck.in   / aditya-2026    (shipper  - "Aditya Joshi")
--   shambhu@bharattruck.in  / shambhu-2026   (driver   - "Shambhu Sir")
--   ramesh@bharattruck.in   / ramesh-2026    (driver   - "Ramesh Yadav")
--   suresh@bharattruck.in   / suresh-2026    (driver   - "Suresh Patil")
--   priya@bharattruck.in    / priya-2026     (shipper  - "Priya Sharma")
-- ============================================================================
BEGIN;

-- 1) Clear BharatTruck transactional data (children first). Users/drivers/pmo_* untouched.
DELETE FROM negotiations;
DELETE FROM location_history;
DELETE FROM payments;
DELETE FROM payouts;
DELETE FROM pod_receipts;
DELETE FROM ops_overrides;
DELETE FROM trip_routes;
DELETE FROM quotes;
DELETE FROM bookings;

-- 2) Users (idempotent on email). bcrypt cost-12 hashes generated with the auth service's bcrypt.
INSERT INTO users (id, email, full_name, role, password_hash, email_verified, kyc_status, city, state, phone_number) VALUES
 ('a1000000-0000-4000-8000-000000000001','aditya@bharattruck.in','Aditya Joshi','shipper','$2b$12$qBw5HbN3r5.ORsAeC3cZrubO7fRhUKW3zW.wDOp1EAh2DsI7vICFy',true,'verified','Mumbai','Maharashtra','+91 98200 10001'),
 ('a1000000-0000-4000-8000-000000000002','priya@bharattruck.in','Priya Sharma','shipper','$2b$12$NibZiD/SCdbjLADJ1xiYvOUGBhSSCnWFL2KKQTLO.kEwfOLq9VMt2',true,'verified','Ahmedabad','Gujarat','+91 99300 20002'),
 ('d1000000-0000-4000-8000-000000000001','shambhu@bharattruck.in','Shambhu Sir','driver','$2b$12$/1TSLiD6Er4c9W0nEpHMAu0AKYHdMQBSSgTW9gXdgB5rqAMx3rrga',true,'verified','Mumbai','Maharashtra','+91 98200 30001'),
 ('d1000000-0000-4000-8000-000000000002','ramesh@bharattruck.in','Ramesh Yadav','driver','$2b$12$g4JFluYhKsNR3FBg95zflOn6DI0s7oRibkO7n5nGVIUdKbTOdhyE2',true,'verified','Delhi','Delhi','+91 98200 30002'),
 ('d1000000-0000-4000-8000-000000000003','suresh@bharattruck.in','Suresh Patil','driver','$2b$12$eWocz1gaBPZFrK0d9bzZ/emrDzh2G81ckPVLDI8n4iQpLDuCExVA.',true,'verified','Bengaluru','Karnataka','+91 98200 30003')
ON CONFLICT (email) DO UPDATE SET
  full_name=EXCLUDED.full_name, role=EXCLUDED.role, password_hash=EXCLUDED.password_hash,
  email_verified=true, kyc_status='verified';

-- 3) Driver profiles (drivers.id is what bookings.driver_id / quotes.driver_id reference).
INSERT INTO drivers (id, user_id, truck_type, truck_number, truck_capacity_kg, vehicle_registration_number, verification_badge, home_base_city, is_available, total_trips, average_rating) VALUES
 ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','HCV','MH 12 AB 3456',12000,'MH12AB3456','verified','Mumbai',true,24,4.6),
 ('d2000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000002','LCV','DL 01 CD 7890',3500,'DL01CD7890','verified','Delhi',true,12,4.3),
 ('d2000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000003','trailer','KA 05 EF 1234',20000,'KA05EF1234','premium','Bengaluru',true,40,4.8)
ON CONFLICT (id) DO NOTHING;

-- 4) Bookings (awarded_quote_id has no FK, safe to set before quotes exist).
--    Shipper = Aditya unless noted. Real Indian freight corridors + coordinates.
INSERT INTO bookings (id, shipper_id, driver_id, shipper_name, shipper_contact,
   source_address, source_lat, source_lng, destination_address, dest_lat, dest_lng,
   load_type, weight_kg, quoted_price, final_price, pickup_date, status, booking_type,
   target_driver_id, auction_deadline, min_acceptable, awarded_quote_id, receiver_email, special_instructions) VALUES
 -- (1) PAID  Delhi -> Jaipur  (direct, Shambhu drove, settled)
 ('b0000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','Aditya Joshi','+91 98200 10001',
   'Okhla Industrial Area, New Delhi, DL',28.5355,77.2730,'Sitapura Industrial Area, Jaipur, RJ',26.7799,75.8360,
   'Electronics',8000,38000,36000,'2026-07-08','paid','direct',NULL,NULL,NULL,'c0000000-0000-4000-8000-000000000001','receiver.jaipur@example.com','Fragile - handle with care'),
 -- (2) IN_TRANSIT  Mumbai -> Nagpur  (direct, Shambhu driving now, GPS trail below)
 ('b0000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','Aditya Joshi','+91 98200 10001',
   'Nhava Sheva Port, Navi Mumbai, MH',18.9490,72.9525,'MIHAN SEZ, Nagpur, MH',21.0760,79.0475,
   'Textiles',18000,52000,50000,'2026-07-19','in_transit','direct',NULL,NULL,NULL,'c0000000-0000-4000-8000-000000000002','receiver.nagpur@example.com','Deliver to gate 3'),
 -- (3) AUCTION  Bengaluru -> Chennai  (open, 3 bids)
 ('b0000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000001',NULL,'Aditya Joshi','+91 98200 10001',
   'Peenya Industrial Area, Bengaluru, KA',13.0289,77.5140,'Ambattur Industrial Estate, Chennai, TN',13.1143,80.1548,
   'Machinery',12000,45000,NULL,'2026-07-28','pending','auction',NULL,'2026-07-24 18:00:00+05:30',40000,NULL,NULL,'Crane needed at drop'),
 -- (4) PENDING DIRECT  Pune -> Hyderabad  (sent to Shambhu, awaiting his acceptance)
 ('b0000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000001',NULL,'Aditya Joshi','+91 98200 10001',
   'Hinjewadi Phase 1, Pune, MH',18.5913,73.7389,'Gachibowli, Hyderabad, TS',17.4401,78.3489,
   'FMCG Goods',6000,30000,NULL,'2026-07-30','pending','direct','d2000000-0000-4000-8000-000000000001',NULL,NULL,NULL,NULL,'Palletised, tail-lift preferred'),
 -- (5) AUCTION  Ahmedabad -> Surat  (Priya's load, 2 bids)
 ('b0000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000002',NULL,'Priya Sharma','+91 99300 20002',
   'Sanand GIDC, Ahmedabad, GJ',22.9877,72.3810,'Sachin GIDC, Surat, GJ',21.0870,72.8830,
   'Chemicals',10000,15000,NULL,'2026-07-26','pending','auction',NULL,'2026-07-23 18:00:00+05:30',13000,NULL,NULL,'Hazmat papers attached');

-- 5) Quotes. quotes.driver_id references drivers.id.
INSERT INTO quotes (id, booking_id, driver_id, amount, message, status, submitted_at) VALUES
 ('c0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001',36000,'Can deliver same day','accepted','2026-07-06 10:00:00+05:30'),
 ('c0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',50000,'HCV available, experienced on this route','accepted','2026-07-18 09:00:00+05:30'),
 ('c0000000-0000-4000-8000-00000000003a','b0000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000001',44000,'Available for pickup on 28th','submitted','2026-07-20 08:00:00+05:30'),
 ('c0000000-0000-4000-8000-00000000003b','b0000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000002',42000,'Best price, LCV clean record','submitted','2026-07-20 08:30:00+05:30'),
 ('c0000000-0000-4000-8000-00000000003c','b0000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000003',46000,'Trailer, insured','countered','2026-07-20 09:00:00+05:30'),
 ('c0000000-0000-4000-8000-00000000005a','b0000000-0000-4000-8000-000000000005','d2000000-0000-4000-8000-000000000002',14500,'Can do this lane weekly','submitted','2026-07-20 10:00:00+05:30'),
 ('c0000000-0000-4000-8000-00000000005b','b0000000-0000-4000-8000-000000000005','d2000000-0000-4000-8000-000000000003',15500,'Hazmat certified','submitted','2026-07-20 10:30:00+05:30');

-- 6) Negotiation history (on Suresh's countered auction bid).
INSERT INTO negotiations (quote_id, booking_id, actor_id, actor_role, amount, message, created_at) VALUES
 ('c0000000-0000-4000-8000-00000000003c','b0000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-000000000003','driver',46000,'Trailer, insured','2026-07-20 09:00:00+05:30'),
 ('c0000000-0000-4000-8000-00000000003c','b0000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000001','shipper',43000,'Can you do 43k?','2026-07-20 11:00:00+05:30');

-- 7) GPS trail for the in-transit trip (Mumbai -> ~Akola, ~60% of the way to Nagpur).
INSERT INTO location_history (booking_id, driver_id, lat, lng, speed_kmh, recorded_at) VALUES
 ('b0000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',18.9490,72.9525,0,   now() - interval '9 hours'),
 ('b0000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',19.2400,73.1300,58,  now() - interval '7 hours'),
 ('b0000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',19.9975,73.7898,62,  now() - interval '5 hours'),
 ('b0000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',19.8762,75.3433,55,  now() - interval '3 hours'),
 ('b0000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',20.7000,77.0000,60,  now() - interval '30 minutes');
UPDATE drivers SET current_latitude=20.7000, current_longitude=77.0000
 WHERE id='d2000000-0000-4000-8000-000000000001';

-- 8) Payment + payout for the paid trip (cash-recorded, per MVP).
INSERT INTO payments (booking_id, payer_id, payee_id, amount, net_amount, payment_method, mode, status, reference, recorded_by, settled_at) VALUES
 ('b0000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001',36000,36000,'cash','cash','settled','CASH-JAIPUR-0708','a1000000-0000-4000-8000-000000000001', now() - interval '10 days');
INSERT INTO payouts (booking_id, driver_id, amount, mode, status, recorded_by) VALUES
 ('b0000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001',36000,'cash','recorded','a1000000-0000-4000-8000-000000000001');

COMMIT;

-- Quick check after running:
-- SELECT status, count(*) FROM bookings GROUP BY status;
-- SELECT b.status, u.full_name shipper, d.truck_number FROM bookings b
--   JOIN users u ON u.id=b.shipper_id LEFT JOIN drivers d ON d.id=b.driver_id ORDER BY b.status;
