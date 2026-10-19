-- ============================================================================
-- BharatTruck — fleet-owner demo seed (2026-07-26)
--
-- Creates ONE realistic mid-size Indian fleet so every fleet-console view has
-- something true to render. Safe to re-run: every insert is idempotent on a
-- fixed UUID or a natural key.
--
-- IT DOES NOT TOUCH the existing shipper/driver/booking data. It only ADDS the
-- `f……` UUID namespace. Nothing here deletes anything.
--
-- The P&L in `trip_economics` is NOT hand-written. It is COMPUTED in SQL from
-- `vehicle_cost_norms` + `vehicle_service_cost_by_age` (migration 0018, seeded
-- from the founder's CV_Parc_Tables.xlsx) using the same formulas the fleet
-- service uses. So the seeded numbers are internally consistent with the model,
-- and re-deriving them in the service must reproduce them.
--
-- Logins created (email / password) — all bcrypt cost-12:
--   balaji@bharattruck.in    / balaji-2026     FLEET OWNER — Shree Balaji Roadlines
--   vikram@bharattruck.in    / vikram-2026     fleet driver (active)
--   sanjay@bharattruck.in    / sanjay-2026     fleet driver (active)
--   imran@bharattruck.in     / imran-2026      fleet driver (active)
--   gurpreet@bharattruck.in  / gurpreet-2026   fleet driver (active)
--   mahesh@bharattruck.in    / mahesh-2026     fleet driver (active)
--   dinesh@bharattruck.in    / dinesh-2026     fleet driver (active)
--   arjun@bharattruck.in     / arjun-2026      driver with a PENDING invite
--   kailash@bharattruck.in   / kailash-2026    driver who LEFT the fleet
--
-- UUID namespace: f1=users, f2=fleet_owner, f3=drivers, f4=vehicles,
--                 f5=bookings, f6=assignments, f7=payouts, f8=shippers
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Users — the owner, eight drivers, two shippers who give the fleet work.
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email, full_name, role, password_hash, email_verified, kyc_status, city, state, phone_number) VALUES
 ('f1000000-0000-4000-8000-000000000001','balaji@bharattruck.in',  'Balaji Deshmukh','fleet_owner','$2b$12$ews7zpKZjIQk1MN6OTE1Ouj4wwupB7SR1Frh4hyqng0e3gFkS1Aji',true,'verified','Nagpur','Maharashtra','+919822040001'),
 ('f1000000-0000-4000-8000-000000000011','vikram@bharattruck.in',  'Vikram Rathod',  'driver',     '$2b$12$GhFxZN0WbiW6n44Hj13ppujkTV94GR3Wlyxh6G43Bgnm.EuBszGLm',true,'verified','Nagpur','Maharashtra','+919822041001'),
 ('f1000000-0000-4000-8000-000000000012','sanjay@bharattruck.in',  'Sanjay Kamble',  'driver',     '$2b$12$mLS5WbDa8oOyFsZkTP.A6u01R7p.FUzxtxXBWT/YN0pOYL6dBIgyy',true,'verified','Nagpur','Maharashtra','+919822041002'),
 ('f1000000-0000-4000-8000-000000000013','imran@bharattruck.in',   'Imran Sheikh',   'driver',     '$2b$12$6NnALfiGNJwfq47gEms7tOGqcVbw7WKrMo03JNJstBMEg/c42RFkm',true,'verified','Bhopal','Madhya Pradesh','+919822041003'),
 ('f1000000-0000-4000-8000-000000000014','gurpreet@bharattruck.in','Gurpreet Singh', 'driver',     '$2b$12$IUQT4hKUubaA9Aqp1Nl02OwyzbzMm.xF8uG9iG2eIvr251Iwxo1He',true,'verified','Ludhiana','Punjab','+919822041004'),
 ('f1000000-0000-4000-8000-000000000015','mahesh@bharattruck.in',  'Mahesh Pawar',   'driver',     '$2b$12$PuroHRrcF4lSlsSdHiQbBeMhaiRvApCsVU0Qt2QqNPWPN/Prv4hvW',true,'verified','Pune','Maharashtra','+919822041005'),
 ('f1000000-0000-4000-8000-000000000016','dinesh@bharattruck.in',  'Dinesh Chauhan', 'driver',     '$2b$12$WlC0jpH5ZTNBaqfHYGHp8ex0EMoFwVnnoOMQi7otrdBjkFOjJou7y',true,'verified','Indore','Madhya Pradesh','+919822041006'),
 ('f1000000-0000-4000-8000-000000000017','arjun@bharattruck.in',   'Arjun Nair',     'driver',     '$2b$12$GK8xjyg5VvkKCR9SN9NPluMd5U5cPeFvUR5UwEdBOtOEb3bMw.9mm',true,'verified','Nashik','Maharashtra','+919822041007'),
 ('f1000000-0000-4000-8000-000000000018','kailash@bharattruck.in', 'Kailash Meena',  'driver',     '$2b$12$iDi6GLnzj4BKkqGZTZPXH.YmjQRn2JvZDk0EMrjH/sxc22uWI10hq',true,'verified','Jaipur','Rajasthan','+919822041008'),
 ('f8000000-0000-4000-8000-000000000001','anand.textiles@bharattruck.in','Anand Textiles Pvt Ltd','shipper','$2b$12$ews7zpKZjIQk1MN6OTE1Ouj4wwupB7SR1Frh4hyqng0e3gFkS1Aji',true,'verified','Surat','Gujarat','+919822050001'),
 ('f8000000-0000-4000-8000-000000000002','deccan.steels@bharattruck.in', 'Deccan Steels Ltd',     'shipper','$2b$12$ews7zpKZjIQk1MN6OTE1Ouj4wwupB7SR1Frh4hyqng0e3gFkS1Aji',true,'verified','Pune','Maharashtra','+919822050002')
ON CONFLICT (id) DO UPDATE SET
  email=EXCLUDED.email, full_name=EXCLUDED.full_name, role=EXCLUDED.role,
  password_hash=EXCLUDED.password_hash, email_verified=true, kyc_status='verified',
  city=EXCLUDED.city, state=EXCLUDED.state;

-- ---------------------------------------------------------------------------
-- 2. The fleet owner party.
-- Monthly overhead = office + 2 admin staff + yard rent in Nagpur. Spread
-- across active vehicles in the P&L roll-up, never charged to a single trip.
-- ---------------------------------------------------------------------------
INSERT INTO fleet_owners (id, user_id, company_name, gstin, pan, contact_phone,
                          billing_address, city, state, monthly_overhead_inr, is_active) VALUES
 ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',
  'Shree Balaji Roadlines Pvt Ltd','27AABCS1429B1ZX','AABCS1429B','+919822040001',
  'Plot 47, MIDC Hingna, Transport Nagar','Nagpur','Maharashtra',185000,true)
ON CONFLICT (id) DO UPDATE SET
  company_name=EXCLUDED.company_name, gstin=EXCLUDED.gstin, pan=EXCLUDED.pan,
  monthly_overhead_inr=EXCLUDED.monthly_overhead_inr;

-- ---------------------------------------------------------------------------
-- 3. Driver profiles.
--
-- LIVE-SCHEMA GOTCHA (discovered 2026-07-26, documented in none of the .sql
-- files): `users` carries an AFTER INSERT trigger `on_user_created_ensure_driver`
-- -> `handle_new_driver()`, which auto-inserts a `drivers` row (with a generated
-- uuid) for every user whose role is 'driver'. A sibling trigger
-- `on_user_role_updated` does the same when a role FLIPS to 'driver'.
--
-- So you CANNOT insert `drivers` with your own id in the same statement batch —
-- the trigger has already claimed the `drivers_user_id_key` unique index and you
-- get a 23505. Work WITH the trigger: let it create the row, then UPDATE it onto
-- the deterministic id this seed needs. Safe because nothing references these
-- rows yet at this point in the script.
--
-- (The trigger only fires for role='driver', so the fleet owner and the two
-- shippers correctly get no drivers row.)
--
-- NOTE the deliberate modelling choice: fleet drivers own NO truck, so
-- truck_number / truck_capacity_kg / vehicle_registration_number stay NULL.
-- Their truck history lives in vehicle_assignments, per order. Only a SOLO
-- driver has those columns filled.
-- ---------------------------------------------------------------------------
UPDATE drivers d SET
  id                 = v.new_id::uuid,
  verification_badge = v.badge,
  home_base_city     = v.city,
  home_base_lat      = v.lat,
  home_base_lng      = v.lng,
  is_available       = true,
  total_trips        = v.trips,
  average_rating     = v.rating,
  languages          = v.langs::text[],
  license_number     = v.licence,
  license_expiry_date= v.expiry::date
FROM (VALUES
 ('f3000000-0000-4000-8000-000000000011','f1000000-0000-4000-8000-000000000011','verified','Nagpur',  21.1458,79.0882, 86,4.7,'{hi,mr}','MH31 20190004521','2029-08-14'),
 ('f3000000-0000-4000-8000-000000000012','f1000000-0000-4000-8000-000000000012','verified','Nagpur',  21.1458,79.0882, 64,4.5,'{hi,mr}','MH31 20200011238','2030-02-09'),
 ('f3000000-0000-4000-8000-000000000013','f1000000-0000-4000-8000-000000000013','verified','Bhopal',  23.2599,77.4126, 71,4.6,'{hi,ur}','MP04 20180007713','2028-11-30'),
 ('f3000000-0000-4000-8000-000000000014','f1000000-0000-4000-8000-000000000014','premium', 'Ludhiana',30.9010,75.8573,132,4.9,'{hi,pa}','PB10 20170003390','2027-06-21'),
 ('f3000000-0000-4000-8000-000000000015','f1000000-0000-4000-8000-000000000015','verified','Pune',    18.5204,73.8567, 49,4.4,'{hi,mr}','MH12 20210014402','2031-03-17'),
 ('f3000000-0000-4000-8000-000000000016','f1000000-0000-4000-8000-000000000016','verified','Indore',  22.7196,75.8577, 58,4.5,'{hi}',   'MP09 20190009985','2029-12-05'),
 ('f3000000-0000-4000-8000-000000000017','f1000000-0000-4000-8000-000000000017','pending', 'Nashik',  19.9975,73.7898, 11,4.2,'{hi,mr}','MH15 20230002214','2033-01-28'),
 ('f3000000-0000-4000-8000-000000000018','f1000000-0000-4000-8000-000000000018','verified','Jaipur',  26.9124,75.7873, 93,4.6,'{hi}',   'RJ14 20160006678','2026-09-12')
) AS v(new_id, user_id, badge, city, lat, lng, trips, rating, langs, licence, expiry)
WHERE d.user_id = v.user_id::uuid;

-- ---------------------------------------------------------------------------
-- 4. Fleet <-> driver affiliation.
-- Six active, one still pending (the owner invited, the driver has not yet
-- accepted), one who has left. That spread is what makes the roster view real.
-- The partial unique index allows exactly one live (pending|active) row per
-- driver, so `left` rows can accumulate as history.
-- ---------------------------------------------------------------------------
INSERT INTO fleet_drivers (id, fleet_owner_id, driver_id, status, monthly_salary_inr, invited_by, invited_at, responded_at, left_at) VALUES
 ('f2100000-0000-4000-8000-000000000011','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000011','active',   34000,'f1000000-0000-4000-8000-000000000001',now()-interval '400 days',now()-interval '398 days',NULL),
 ('f2100000-0000-4000-8000-000000000012','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000012','active',   31000,'f1000000-0000-4000-8000-000000000001',now()-interval '360 days',now()-interval '359 days',NULL),
 ('f2100000-0000-4000-8000-000000000013','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000013','active',   32500,'f1000000-0000-4000-8000-000000000001',now()-interval '300 days',now()-interval '299 days',NULL),
 ('f2100000-0000-4000-8000-000000000014','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000014','active',   38000,'f1000000-0000-4000-8000-000000000001',now()-interval '520 days',now()-interval '519 days',NULL),
 ('f2100000-0000-4000-8000-000000000015','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000015','active',   29500,'f1000000-0000-4000-8000-000000000001',now()-interval '210 days',now()-interval '208 days',NULL),
 ('f2100000-0000-4000-8000-000000000016','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000016','active',   30500,'f1000000-0000-4000-8000-000000000001',now()-interval '180 days',now()-interval '179 days',NULL),
 ('f2100000-0000-4000-8000-000000000017','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000017','pending',  28000,'f1000000-0000-4000-8000-000000000001',now()-interval '3 days',NULL,NULL),
 ('f2100000-0000-4000-8000-000000000018','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000018','left',     33000,'f1000000-0000-4000-8000-000000000001',now()-interval '600 days',now()-interval '598 days',now()-interval '45 days')
ON CONFLICT (id) DO UPDATE SET
  status=EXCLUDED.status, monthly_salary_inr=EXCLUDED.monthly_salary_inr,
  responded_at=EXCLUDED.responded_at, left_at=EXCLUDED.left_at;

-- ---------------------------------------------------------------------------
-- 5. The trucks. Twelve, deliberately spread across model_category, emission
-- norm and AGE, because the service-cost curve is age-indexed and non-linear
-- (peaks ~year 3). A single-vintage fleet would hide that entirely.
--
-- driver_id stays NULL on every row — these are fleet-owned, and the
-- `vehicles_exactly_one_owner` CHECK forbids both owners being set.
-- ---------------------------------------------------------------------------
INSERT INTO vehicles (id, driver_id, fleet_owner_id, rc_number, maker_model, body_type, axle_config,
                      capacity_tons, fuel_type, rc_status, rc_expiry, is_active,
                      model_category, emission_norm, manufacture_year, volume_cuft, current_odometer_km) VALUES
 ('f4000000-0000-4000-8000-000000000001',NULL,'f2000000-0000-4000-8000-000000000001','MH31CQ4512','Tata Signa 4825.TK','flatbed','10x2',    45.00,'diesel','verified','2029-03-31',true,'HCV Cargo 42-48T','BS6',    2023,2048, 214500),
 ('f4000000-0000-4000-8000-000000000002',NULL,'f2000000-0000-4000-8000-000000000001','MH31CQ4518','Ashok Leyland 4225','flatbed','10x2',    42.00,'diesel','verified','2029-05-15',true,'HCV Cargo 42-48T','BS6',    2023,2048, 198300),
 ('f4000000-0000-4000-8000-000000000003',NULL,'f2000000-0000-4000-8000-000000000001','MH31CP8834','Tata Signa 3525.TK','open','8x4',  35.00,'diesel','verified','2028-09-20',true,'HCV Cargo 35-40T','BS6',    2022,2048, 341200),
 ('f4000000-0000-4000-8000-000000000004',NULL,'f2000000-0000-4000-8000-000000000001','MH31CP8840','BharatBenz 3532R','container','8x4',    35.00,'diesel','verified','2028-10-02',true,'HCV Cargo 35-40T','BS6',    2022,2048, 356800),
 ('f4000000-0000-4000-8000-000000000005',NULL,'f2000000-0000-4000-8000-000000000001','MH31CN2201','Tata Prima 2825.K','open','6x4',   28.00,'diesel','verified','2027-12-11',true,'HCV Cargo 25-31T','BS6',    2021,2048, 468900),
 ('f4000000-0000-4000-8000-000000000006',NULL,'f2000000-0000-4000-8000-000000000001','MH31CN2214','Ashok Leyland 2820','open','6x4',  28.00,'diesel','verified','2027-11-28',true,'HCV Cargo 25-31T','BS4',    2019,2048, 612400),
 ('f4000000-0000-4000-8000-000000000007',NULL,'f2000000-0000-4000-8000-000000000001','MH31CM7756','Eicher Pro 6019','container','6x2',     25.00,'diesel','verified','2027-04-08',true,'HCV Cargo 25-31T','BS4',    2019,2048, 587100),
 ('f4000000-0000-4000-8000-000000000008',NULL,'f2000000-0000-4000-8000-000000000001','MH31CR1102','Tata Ultra 1918.T','container','4x2',   18.00,'diesel','verified','2030-01-19',true,'MCV Cargo (15-19T)','BS6_PH2',2025,1500,  62700),
 ('f4000000-0000-4000-8000-000000000009',NULL,'f2000000-0000-4000-8000-000000000001','MH31CR1108','Eicher Pro 3019','open','4x2',     17.00,'diesel','verified','2030-02-25',true,'MCV Cargo (15-19T)','BS6_PH2',2025,1500,  48300),
 ('f4000000-0000-4000-8000-000000000010',NULL,'f2000000-0000-4000-8000-000000000001','MH31CL9930','BharatBenz 1415R','container','4x2',    14.00,'diesel','verified','2028-06-30',true,'ICV Cargo (Upto 14T)','BS6',2022,1260, 288400),
 ('f4000000-0000-4000-8000-000000000011',NULL,'f2000000-0000-4000-8000-000000000001','MH31CL9944','Tata Ultra 1412','container','4x2',     14.00,'diesel','verified','2028-08-14',true,'ICV Cargo (Upto 14T)','BS6',2022,1260, 271900),
 ('f4000000-0000-4000-8000-000000000012',NULL,'f2000000-0000-4000-8000-000000000001','MH31CK5567','Eicher Pro 2059','open','4x2',      6.00,'diesel','verified','2027-07-22',true,'LCV (4-7 T)','BS4',      2020,1050, 402600)
ON CONFLICT (id) DO UPDATE SET
  fleet_owner_id=EXCLUDED.fleet_owner_id, maker_model=EXCLUDED.maker_model,
  model_category=EXCLUDED.model_category, emission_norm=EXCLUDED.emission_norm,
  manufacture_year=EXCLUDED.manufacture_year, volume_cuft=EXCLUDED.volume_cuft,
  capacity_tons=EXCLUDED.capacity_tons, current_odometer_km=EXCLUDED.current_odometer_km;

-- ---------------------------------------------------------------------------
-- 6. Finance. Nine of twelve are on loan — which is the whole reason this
-- feature exists. Two are owned outright (emi 0) and one is nearly paid off.
-- EMIs are realistic for the Indian CV market: ~₹95k/mo on a new 5-axle
-- tractor-trailer, ~₹42k on an ICV.
-- ---------------------------------------------------------------------------
INSERT INTO vehicle_finance (vehicle_id, lender, loan_account_no, principal_inr, emi_amount_inr,
                             emi_day_of_month, tenure_months, interest_rate_pct, start_date, end_date,
                             outstanding_inr, insurance_annual_inr, permit_annual_inr, fitness_annual_inr) VALUES
 ('f4000000-0000-4000-8000-000000000001','Sundaram Finance','SF-NAG-2023-88401',4850000, 96500,5,60,10.25,'2023-04-10','2028-04-10',2910000,148000,42000,14000),
 ('f4000000-0000-4000-8000-000000000002','Sundaram Finance','SF-NAG-2023-88407',4620000, 92000,5,60,10.25,'2023-06-15','2028-06-15',2870000,142000,42000,14000),
 ('f4000000-0000-4000-8000-000000000003','Shriram Finance', 'SHR-NAG-2022-51120',3980000,  81500,10,60,11.00,'2022-09-01','2027-09-01',1710000,126000,38000,12000),
 ('f4000000-0000-4000-8000-000000000004','Shriram Finance', 'SHR-NAG-2022-51133',4120000,  84000,10,60,11.00,'2022-10-05','2027-10-05',1810000,131000,38000,12000),
 ('f4000000-0000-4000-8000-000000000005','HDFC Bank',       'HDFC-CV-2021-77012',3250000,  68000,7,60, 9.75,'2021-12-20','2026-12-20', 410000,108000,34000,11000),
 ('f4000000-0000-4000-8000-000000000006','Cholamandalam',   'CHOLA-2019-30288',  2680000,      0,NULL,48,10.50,'2019-08-01','2023-08-01',      0, 92000,34000,11000),
 ('f4000000-0000-4000-8000-000000000007','Cholamandalam',   'CHOLA-2019-30295',  2540000,      0,NULL,48,10.50,'2019-05-12','2023-05-12',      0, 88000,34000,11000),
 ('f4000000-0000-4000-8000-000000000008','Tata Capital',    'TCL-2025-99820',    2980000,  61500,3,60, 9.40,'2025-02-18','2030-02-18',2640000, 96000,28000, 9000),
 ('f4000000-0000-4000-8000-000000000009','Tata Capital',    'TCL-2025-99834',    2870000,  59000,3,60, 9.40,'2025-04-22','2030-04-22',2580000, 93000,28000, 9000),
 ('f4000000-0000-4000-8000-000000000010','Kotak Mahindra',  'KMB-CV-2022-44190', 2050000,  42500,12,60,10.10,'2022-07-08','2027-07-08', 880000, 74000,24000, 8000),
 ('f4000000-0000-4000-8000-000000000011','Kotak Mahindra',  'KMB-CV-2022-44203', 1980000,  41000,12,60,10.10,'2022-08-19','2027-08-19', 905000, 71000,24000, 8000),
 ('f4000000-0000-4000-8000-000000000012','Mahindra Finance','MMFSL-2020-11507',  1120000,  23500,20,60, 11.75,'2020-11-30','2025-11-30',      0, 46000,18000, 6000)
ON CONFLICT (vehicle_id) DO UPDATE SET
  lender=EXCLUDED.lender, emi_amount_inr=EXCLUDED.emi_amount_inr,
  outstanding_inr=EXCLUDED.outstanding_inr, insurance_annual_inr=EXCLUDED.insurance_annual_inr,
  permit_annual_inr=EXCLUDED.permit_annual_inr, fitness_annual_inr=EXCLUDED.fitness_annual_inr;

-- ---------------------------------------------------------------------------
-- 7. Permits. Most long-haul trucks carry a national permit; three are
-- state-restricted, which is precisely WHY those trucks stay on a short regional
-- corridor. The corridor is a CONSEQUENCE of the permit, not a hardcoded route.
-- ---------------------------------------------------------------------------
INSERT INTO vehicle_permits (id, vehicle_id, permit_type, allowed_states, permit_number, issued_on, expiry_date, is_active) VALUES
 ('f5100000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001','national','{}','NP-MH31-2023-4512','2023-04-20','2028-04-19',true),
 ('f5100000-0000-4000-8000-000000000002','f4000000-0000-4000-8000-000000000002','national','{}','NP-MH31-2023-4518','2023-06-25','2028-06-24',true),
 ('f5100000-0000-4000-8000-000000000003','f4000000-0000-4000-8000-000000000003','national','{}','NP-MH31-2022-8834','2022-09-12','2027-09-11',true),
 ('f5100000-0000-4000-8000-000000000004','f4000000-0000-4000-8000-000000000004','national','{}','NP-MH31-2022-8840','2022-10-15','2027-10-14',true),
 ('f5100000-0000-4000-8000-000000000005','f4000000-0000-4000-8000-000000000005','national','{}','NP-MH31-2021-2201','2021-12-28','2026-12-27',true),
 ('f5100000-0000-4000-8000-000000000006','f4000000-0000-4000-8000-000000000006','state','{MH,TS,AP,KA}','SP-MH31-2019-2214','2019-08-10','2027-08-09',true),
 ('f5100000-0000-4000-8000-000000000007','f4000000-0000-4000-8000-000000000007','national','{}','NP-MH31-2019-7756','2019-05-20','2027-05-19',true),
 ('f5100000-0000-4000-8000-000000000008','f4000000-0000-4000-8000-000000000008','national','{}','NP-MH31-2025-1102','2025-02-25','2030-02-24',true),
 ('f5100000-0000-4000-8000-000000000009','f4000000-0000-4000-8000-000000000009','national','{}','NP-MH31-2025-1108','2025-04-30','2030-04-29',true),
 ('f5100000-0000-4000-8000-000000000010','f4000000-0000-4000-8000-000000000010','state','{MH,CG,MP}','SP-MH31-2022-9930','2022-07-15','2028-07-14',true),
 ('f5100000-0000-4000-8000-000000000011','f4000000-0000-4000-8000-000000000011','state','{MH,MP,GJ}','SP-MH31-2022-9944','2022-08-25','2028-08-24',true),
 ('f5100000-0000-4000-8000-000000000012','f4000000-0000-4000-8000-000000000012','state','{MH}','SP-MH31-2020-5567','2020-12-05','2027-12-04',true)
ON CONFLICT (id) DO UPDATE SET permit_type=EXCLUDED.permit_type, allowed_states=EXCLUDED.allowed_states;

-- ---------------------------------------------------------------------------
-- 8. Corridors. A Nagpur hub fleet, so the primary lanes radiate from Nagpur,
-- plus two national trunk lanes read from fr8.in on 2026-07-26 (Mumbai-Delhi
-- 1414 km, Delhi-Kolkata 1480 km). Changeable, not hardcoded.
-- ---------------------------------------------------------------------------
INSERT INTO vehicle_lanes (id, vehicle_id, origin_city, destination_city, origin_lat, origin_lng,
                           dest_lat, dest_lng, typical_distance_km, is_primary, trips_observed) VALUES
 ('f5200000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001','Nagpur','Delhi',    21.1458,79.0882,28.7041,77.1025,1080,true, 31),
 ('f5200000-0000-4000-8000-000000000002','f4000000-0000-4000-8000-000000000002','Delhi','Kolkata',   28.7041,77.1025,22.5726,88.3639,1480,true, 27),
 ('f5200000-0000-4000-8000-000000000003','f4000000-0000-4000-8000-000000000003','Nagpur','Mumbai',   21.1458,79.0882,19.0760,72.8777, 840,true, 44),
 ('f5200000-0000-4000-8000-000000000004','f4000000-0000-4000-8000-000000000004','Nagpur','Kolkata',  21.1458,79.0882,22.5726,88.3639,1120,true, 29),
 ('f5200000-0000-4000-8000-000000000005','f4000000-0000-4000-8000-000000000005','Hyderabad','Mumbai',17.3850,78.4867,19.0760,72.8777, 706,true, 38),
 ('f5200000-0000-4000-8000-000000000006','f4000000-0000-4000-8000-000000000006','Nagpur','Hyderabad',21.1458,79.0882,17.3850,78.4867, 500,true, 52),
 ('f5200000-0000-4000-8000-000000000007','f4000000-0000-4000-8000-000000000007','Nagpur','Bangalore',21.1458,79.0882,12.9716,77.5946,1090,true, 24),
 ('f5200000-0000-4000-8000-000000000008','f4000000-0000-4000-8000-000000000008','Nagpur','Indore',   21.1458,79.0882,22.7196,75.8577, 440,true, 19),
 ('f5200000-0000-4000-8000-000000000009','f4000000-0000-4000-8000-000000000009','Nagpur','Pune',     21.1458,79.0882,18.5204,73.8567, 710,true, 16),
 ('f5200000-0000-4000-8000-000000000010','f4000000-0000-4000-8000-000000000010','Nagpur','Raipur',   21.1458,79.0882,21.2514,81.6296, 290,true, 63),
 ('f5200000-0000-4000-8000-000000000011','f4000000-0000-4000-8000-000000000011','Nagpur','Bhopal',   21.1458,79.0882,23.2599,77.4126, 350,true, 47),
 ('f5200000-0000-4000-8000-000000000012','f4000000-0000-4000-8000-000000000012','Nagpur','Amravati', 21.1458,79.0882,20.9374,77.7796, 155,true, 88),
 ('f5200000-0000-4000-8000-000000000101','f4000000-0000-4000-8000-000000000001','Mumbai','Delhi',    19.0760,72.8777,28.7041,77.1025,1414,false, 9),
 ('f5200000-0000-4000-8000-000000000103','f4000000-0000-4000-8000-000000000003','Nagpur','Ahmedabad',21.1458,79.0882,23.0225,72.5714, 990,false,11)
ON CONFLICT (id) DO UPDATE SET typical_distance_km=EXCLUDED.typical_distance_km, trips_observed=EXCLUDED.trips_observed;

-- ---------------------------------------------------------------------------
-- 9. Historical completed+paid trips over the last 180 days.
--
-- Trip COUNT per vehicle is DERIVED, not typed: it comes from the truck's norm
-- `kms_per_year` times a per-vehicle utilisation factor. `util` is relative to
-- the workbook's parc-AVERAGE annual km — which is an average across all
-- vintages including idle ones — so a hard-working long-haul truck legitimately
-- sits above 1.0 and a neglected asset well below. That spread is the entire
-- point of the utilisation and EMI-coverage views: with a flat factor every
-- truck looks identical and the dashboard says nothing.
--
-- Re-running is safe and reproducible: booking ids are md5(vehicle:i) and the
-- per-trip price jitter is hashtext-derived, so no randomness leaks in.
-- ---------------------------------------------------------------------------
WITH cfg AS (
  SELECT v.id AS vehicle_id, n.kms_per_year, n.payload_tons_typical,
         l.origin_city, l.destination_city, l.origin_lat, l.origin_lng, l.dest_lat, l.dest_lng,
         l.typical_distance_km::numeric AS dist, u.util, u.rate_per_km,
         greatest(1, floor(n.kms_per_year * u.util * (180.0/365.0) / l.typical_distance_km)::int) AS n_trips
  FROM vehicles v
  JOIN vehicle_cost_norms n ON n.model_category = v.model_category
  JOIN vehicle_lanes l ON l.vehicle_id = v.id AND l.is_primary
  JOIN (VALUES
    ('f4000000-0000-4000-8000-000000000001',1.30,62.0),  -- star: new 45T, high EMI but out-earns it
    ('f4000000-0000-4000-8000-000000000002',1.22,61.0),
    ('f4000000-0000-4000-8000-000000000003',1.18,58.0),
    ('f4000000-0000-4000-8000-000000000004',0.95,57.0),
    ('f4000000-0000-4000-8000-000000000005',1.05,52.0),
    ('f4000000-0000-4000-8000-000000000006',0.88,49.0),  -- old, loan closed: quietly the best net
    ('f4000000-0000-4000-8000-000000000007',0.72,48.0),
    ('f4000000-0000-4000-8000-000000000008',0.62,46.0),  -- 2025 MCV, big EMI, under-utilised
    ('f4000000-0000-4000-8000-000000000009',0.55,45.0),  -- worst asset in the fleet
    ('f4000000-0000-4000-8000-000000000010',1.10,38.0),
    ('f4000000-0000-4000-8000-000000000011',0.86,37.0),
    ('f4000000-0000-4000-8000-000000000012',0.70,30.0)
  ) AS u(vid,util,rate_per_km) ON u.vid::uuid = v.id
  WHERE v.fleet_owner_id='f2000000-0000-4000-8000-000000000001'
),
trips AS (
  SELECT c.*, i,
         md5(c.vehicle_id::text || ':' || i::text)::uuid AS booking_id,
         (now() - ((180.0 * i / c.n_trips) || ' days')::interval)::timestamptz AS completed_at,
         0.94 + 0.12 * (mod(abs(hashtext(c.vehicle_id::text || i::text)),100)/100.0) AS jitter,
         (ARRAY['f3000000-0000-4000-8000-000000000011','f3000000-0000-4000-8000-000000000012',
                'f3000000-0000-4000-8000-000000000013','f3000000-0000-4000-8000-000000000014',
                'f3000000-0000-4000-8000-000000000015','f3000000-0000-4000-8000-000000000016'
          ])[1 + mod(i, 6)]::uuid AS driver_id
  FROM cfg c, generate_series(1, c.n_trips) i
)
INSERT INTO bookings (id, shipper_id, driver_id, fleet_owner_id, vehicle_id,
                      shipper_name, shipper_contact, source_address, source_lat, source_lng,
                      destination_address, dest_lat, dest_lng, load_type, weight_kg,
                      quoted_price, final_price, pickup_date, status, booking_type, created_at, updated_at)
SELECT t.booking_id,
       CASE WHEN mod(t.i,2)=0 THEN 'f8000000-0000-4000-8000-000000000001'::uuid ELSE 'f8000000-0000-4000-8000-000000000002'::uuid END,
       t.driver_id, 'f2000000-0000-4000-8000-000000000001', t.vehicle_id,
       CASE WHEN mod(t.i,2)=0 THEN 'Anand Textiles Pvt Ltd' ELSE 'Deccan Steels Ltd' END,
       CASE WHEN mod(t.i,2)=0 THEN '+919822050001' ELSE '+919822050002' END,
       t.origin_city || ' — Transport Nagar goods yard', t.origin_lat, t.origin_lng,
       t.destination_city || ' — consignee warehouse', t.dest_lat, t.dest_lng,
       CASE WHEN mod(t.i,2)=0 THEN 'textiles' ELSE 'steel_coil' END,
       round(t.payload_tons_typical * 1000 * (0.72 + 0.26*(mod(abs(hashtext(t.booking_id::text)),100)/100.0)))::numeric,
       round(t.dist * t.rate_per_km * t.jitter), round(t.dist * t.rate_per_km * t.jitter),
       (t.completed_at - interval '1 day')::date, 'paid', 'auction',
       t.completed_at - interval '2 days', t.completed_at
FROM trips t
ON CONFLICT (id) DO NOTHING;

-- Every historical assignment is RELEASED. The three partial-unique indexes
-- (one live per booking / per vehicle / per driver) only constrain rows where
-- released_at IS NULL, so history accumulates freely.
INSERT INTO vehicle_assignments (id, fleet_owner_id, booking_id, vehicle_id, driver_id, assigned_by, assigned_at, released_at, created_at)
SELECT md5('asg:'||b.id::text)::uuid, b.fleet_owner_id, b.id, b.vehicle_id, b.driver_id,
       'f1000000-0000-4000-8000-000000000001', b.created_at, b.updated_at + interval '2 hours', b.created_at
FROM bookings b
WHERE b.fleet_owner_id='f2000000-0000-4000-8000-000000000001' AND b.vehicle_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Q15: the money goes to WHOEVER BID. The fleet bid, so payee_type='fleet_owner'
-- and driver_id stays NULL — the fleet driver is salaried, not paid per trip.
-- mode/status use the live allowed sets ('direct'/'recorded'); escrow is out of MVP.
INSERT INTO payouts (id, booking_id, driver_id, fleet_owner_id, payee_type, amount, mode, status, recorded_by, created_at, updated_at)
SELECT md5('pay:'||b.id::text)::uuid, b.id, NULL, b.fleet_owner_id, 'fleet_owner',
       b.final_price, 'direct', 'recorded', 'f1000000-0000-4000-8000-000000000001',
       b.updated_at + interval '3 days', b.updated_at + interval '3 days'
FROM bookings b
WHERE b.fleet_owner_id='f2000000-0000-4000-8000-000000000001'
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. trip_economics — the per-trip P&L roll-up.
--
-- NOT hand-written. Every cost line is DERIVED from vehicle_cost_norms +
-- vehicle_service_cost_by_age, keyed on the truck's model_category, emission
-- norm and AGE. Service cost in particular is age-indexed and non-linear (it
-- peaks around year 3), which is exactly what a flat per-km maintenance
-- constant gets wrong at both ends.
--
-- Consumable prices come from the global fleet_cost_settings row, so changing
-- the diesel price in one place re-prices the whole model.
-- ---------------------------------------------------------------------------
WITH px AS (
  SELECT diesel_price_inr d, def_price_inr df, engine_oil_price_inr eo, gear_oil_price_inr go
  FROM fleet_cost_settings WHERE fleet_owner_id IS NULL
),
base AS (
  SELECT b.id booking_id, b.fleet_owner_id, b.vehicle_id, b.driver_id, b.final_price::numeric revenue,
         b.weight_kg::numeric, b.created_at started_at, b.updated_at completed_at,
         l.typical_distance_km::numeric dist, v.capacity_tons::numeric*1000 capacity_kg,
         v.volume_cuft::numeric capacity_cuft, n.*, v.emission_norm,
         greatest(1, least(10, 2026 - v.manufacture_year)) age_years,
         fd.monthly_salary_inr::numeric salary
  FROM bookings b
  JOIN vehicles v ON v.id=b.vehicle_id
  JOIN vehicle_cost_norms n ON n.model_category=v.model_category
  JOIN vehicle_lanes l ON l.vehicle_id=v.id AND l.is_primary
  LEFT JOIN fleet_drivers fd ON fd.driver_id=b.driver_id AND fd.status='active'
  WHERE b.fleet_owner_id='f2000000-0000-4000-8000-000000000001'
),
calc AS (
  SELECT bs.*, px.*,
    CASE WHEN bs.emission_norm='BS4' THEN coalesce(bs.kmpl_bs4,bs.kmpl_bs6) ELSE bs.kmpl_bs6 END kmpl,
    CASE WHEN bs.emission_norm='BS4' THEN bs.def_pct_bs4 ELSE bs.def_pct_bs6 END def_pct,
    CASE bs.emission_norm WHEN 'BS6_PH2' THEN bs.eng_oil_km_bs6ph2 WHEN 'BS6' THEN bs.eng_oil_km_bs6 ELSE bs.eng_oil_km_bs4 END eo_km,
    CASE bs.emission_norm WHEN 'BS6_PH2' THEN bs.eng_oil_l_bs6ph2  WHEN 'BS6' THEN bs.eng_oil_l_bs6  ELSE bs.eng_oil_l_bs4  END eo_l,
    CASE bs.emission_norm WHEN 'BS6_PH2' THEN bs.gear_oil_km_bs6ph2 WHEN 'BS6' THEN bs.gear_oil_km_bs6 ELSE bs.gear_oil_km_bs4 END go_km,
    CASE bs.emission_norm WHEN 'BS6_PH2' THEN bs.gear_oil_l_bs6ph2  WHEN 'BS6' THEN bs.gear_oil_l_bs6  ELSE bs.gear_oil_l_bs4  END go_l,
    sca.annual_cost_inr service_annual
  FROM base bs CROSS JOIN px
  JOIN vehicle_service_cost_by_age sca ON sca.super_category=bs.super_category AND sca.age_years=bs.age_years
),
final AS (
  SELECT c.*,
    round(c.dist/c.kmpl*c.d,2)                    fuel_cost,
    round(c.dist/c.kmpl*c.def_pct*c.df,2)         def_cost,
    round(c.dist/c.eo_km*c.eo_l*c.eo,2)           engine_oil_cost,
    round(c.dist/c.go_km*c.go_l*c.go,2)           gear_oil_cost,
    round(c.service_annual/c.kms_per_year*c.dist,2) service_cost,
    round(c.dist*c.tyre_cost_per_km,2)            tyre_cost,
    -- Q18: driver wage spread per km over the truck's annual km, scaled by the
    -- vehicle-type wage_weight (an HCV carries more of the wage bill than an SCV).
    round(c.dist*(coalesce(c.salary,31000)*12.0/c.kms_per_year)*(c.wage_weight/2.0),2) wage_alloc
  FROM calc c
)
INSERT INTO trip_economics (booking_id, fleet_owner_id, vehicle_id, driver_id, revenue_inr,
  fuel_cost_est_inr, def_cost_est_inr, engine_oil_cost_inr, gear_oil_cost_inr, service_cost_inr,
  tyre_cost_inr, driver_wage_alloc_inr, toll_cost_inr, other_cost_inr, running_cost_inr, net_profit_inr,
  distance_km_quoted, distance_km_actual, laden_weight_kg, capacity_kg, volume_used_cuft, capacity_cuft,
  started_at, completed_at, model_version)
SELECT f.booking_id, f.fleet_owner_id, f.vehicle_id, f.driver_id, f.revenue,
  f.fuel_cost, f.def_cost, f.engine_oil_cost, f.gear_oil_cost, f.service_cost, f.tyre_cost, f.wage_alloc,
  round(f.dist*1.15,2),  -- NH toll ~Rs1.15/km. An ESTIMATE, not measured.
  0,
  round(f.fuel_cost+f.def_cost+f.engine_oil_cost+f.gear_oil_cost+f.service_cost+f.tyre_cost+f.wage_alloc+f.dist*1.15,2),
  round(f.revenue-(f.fuel_cost+f.def_cost+f.engine_oil_cost+f.gear_oil_cost+f.service_cost+f.tyre_cost+f.wage_alloc+f.dist*1.15),2),
  f.dist, round(f.dist*1.03,2),   -- actual runs ~3% over the planned lane
  f.weight_kg, f.capacity_kg,
  round(f.capacity_cuft*(f.weight_kg/nullif(f.capacity_kg,0))*0.92,2), f.capacity_cuft,
  f.started_at, f.completed_at, 'fleet-pnl-v1'
FROM final f
ON CONFLICT (booking_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 11. Three LIVE in-transit trips (so the fleet map has moving assets) and one
-- open auction the fleet has bid on but not yet won.
--
-- These carry LIVE assignments (released_at NULL) — which is exactly what the
-- three partial-unique indexes exist to protect: one live assignment per
-- booking, per vehicle, and per driver.
-- ---------------------------------------------------------------------------
INSERT INTO bookings (id, shipper_id, driver_id, fleet_owner_id, vehicle_id, shipper_name, shipper_contact,
  source_address, source_lat, source_lng, destination_address, dest_lat, dest_lng,
  load_type, weight_kg, quoted_price, final_price, pickup_date, status, booking_type, created_at, updated_at) VALUES
 ('f5000000-0000-4000-8000-00000000a001','f8000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000011','f2000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001','Anand Textiles Pvt Ltd','+919822050001','Nagpur — Transport Nagar goods yard',21.1458,79.0882,'Delhi — Narela industrial area',28.7041,77.1025,'textiles',38500,68200,68200,current_date-1,'in_transit','auction',now()-interval '30 hours',now()-interval '20 minutes'),
 ('f5000000-0000-4000-8000-00000000a002','f8000000-0000-4000-8000-000000000002','f3000000-0000-4000-8000-000000000013','f2000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000005','Deccan Steels Ltd','+919822050002','Hyderabad — Balanagar steel depot',17.3850,78.4867,'Mumbai — Bhiwandi warehouse',19.0760,72.8777,'steel_coil',24800,37500,37500,current_date,'in_transit','auction',now()-interval '14 hours',now()-interval '5 minutes'),
 ('f5000000-0000-4000-8000-00000000a003','f8000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000016','f2000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000010','Anand Textiles Pvt Ltd','+919822050001','Nagpur — Transport Nagar goods yard',21.1458,79.0882,'Raipur — Urla industrial estate',21.2514,81.6296,'textiles',11200,11400,11400,current_date,'in_transit','auction',now()-interval '5 hours',now()-interval '2 minutes'),
 ('f5000000-0000-4000-8000-00000000b001','f8000000-0000-4000-8000-000000000002',NULL,NULL,NULL,'Deccan Steels Ltd','+919822050002','Pune — Chakan plant',18.5204,73.8567,'Bangalore — Peenya industrial area',12.9716,77.5946,'steel_coil',31000,49500,NULL,current_date+2,'negotiating','auction',now()-interval '6 hours',now()-interval '6 hours')
ON CONFLICT (id) DO NOTHING;

INSERT INTO vehicle_assignments (id, fleet_owner_id, booking_id, vehicle_id, driver_id, assigned_by, assigned_at, released_at, created_at) VALUES
 ('f6000000-0000-4000-8000-00000000a001','f2000000-0000-4000-8000-000000000001','f5000000-0000-4000-8000-00000000a001','f4000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000011','f1000000-0000-4000-8000-000000000001',now()-interval '31 hours',NULL,now()-interval '31 hours'),
 ('f6000000-0000-4000-8000-00000000a002','f2000000-0000-4000-8000-000000000001','f5000000-0000-4000-8000-00000000a002','f4000000-0000-4000-8000-000000000005','f3000000-0000-4000-8000-000000000013','f1000000-0000-4000-8000-000000000001',now()-interval '15 hours',NULL,now()-interval '15 hours'),
 ('f6000000-0000-4000-8000-00000000a003','f2000000-0000-4000-8000-000000000001','f5000000-0000-4000-8000-00000000a003','f4000000-0000-4000-8000-000000000010','f3000000-0000-4000-8000-000000000016','f1000000-0000-4000-8000-000000000001',now()-interval '6 hours',NULL,now()-interval '6 hours')
ON CONFLICT (id) DO NOTHING;

-- The fleet's live bid: fleet_owner_id set, driver_id NULL. Q10 — a fleet may
-- bid with no truck currently free; the assignment step is what gates departure.
INSERT INTO quotes (id, booking_id, driver_id, fleet_owner_id, amount, message, status, submitted_at, expires_at, updated_at) VALUES
 ('f7000000-0000-4000-8000-00000000b001','f5000000-0000-4000-8000-00000000b001',NULL,'f2000000-0000-4000-8000-000000000001',47800,'32ft MXL available at Chakan, national permit, GPS tracked.','submitted',now()-interval '4 hours',now()+interval '20 hours',now()-interval '4 hours')
ON CONFLICT (id) DO NOTHING;

-- Breadcrumb trails: 40 points each, ~18 min apart, interpolated along the lane.
INSERT INTO location_history (booking_id, driver_id, vehicle_id, lat, lng, heading, speed_kmh, recorded_at, created_at)
SELECT t.bid::uuid, t.did::uuid, t.vid::uuid,
       t.lat0 + (t.lat1-t.lat0)*(g/40.0), t.lng0 + (t.lng1-t.lng0)*(g/40.0),
       t.hdg, 48 + mod(abs(hashtext(t.bid||g::text)),24),
       now() - ((40-g) * interval '18 minutes'), now() - ((40-g) * interval '18 minutes')
FROM (VALUES
 ('f5000000-0000-4000-8000-00000000a001','f3000000-0000-4000-8000-000000000011','f4000000-0000-4000-8000-000000000001',21.1458,79.0882,28.7041,77.1025,338.0),
 ('f5000000-0000-4000-8000-00000000a002','f3000000-0000-4000-8000-000000000013','f4000000-0000-4000-8000-000000000005',17.3850,78.4867,19.0760,72.8777,295.0),
 ('f5000000-0000-4000-8000-00000000a003','f3000000-0000-4000-8000-000000000016','f4000000-0000-4000-8000-000000000010',21.1458,79.0882,21.2514,81.6296, 88.0)
) AS t(bid,did,vid,lat0,lng0,lat1,lng1,hdg), generate_series(1,40) g;

COMMIT;

-- ============================================================================
-- Verified against live on 2026-07-26 after running:
--   12 vehicles / 12 finance / 12 permits / 14 lanes / 6 active drivers
--   620 bookings (617 historical paid + 3 live in_transit) + 1 open auction
--   617 assignments (3 live), 617 payouts, 617 trip_economics rows
--   120 GPS breadcrumbs
--
-- Resulting EMI-coverage spread — 7 of 12 trucks clear their EMI + share of
-- fixed costs + overhead in a month, 5 do not:
--   MH31CN2214  +60,702   loan closed, well utilised          CLEARS
--   MH31CM7756  +41,797   loan closed                         CLEARS
--   MH31CQ4512  +35,101   new 45T, big EMI but out-earns it   CLEARS
--   MH31CQ4518  +31,018                                       CLEARS
--   MH31CN2201  +12,358                                       CLEARS
--   MH31CP8834   +8,008                                       CLEARS
--   MH31CL9930   +7,518                                       CLEARS
--   MH31CL9944  -10,255                                       SHORT
--   MH31CP8840  -21,598                                       SHORT
--   MH31CK5567  -23,502   small LCV, structurally marginal    SHORT
--   MH31CR1102  -27,558   2025 MCV, big EMI, under-utilised   SHORT
--   MH31CR1108  -33,980   worst asset in the fleet            SHORT
--
-- That is the founder's thesis made visible: the 45T with the LARGEST EMI still
-- clears it because it runs 7,787 km/month, while the two newest MCVs cannot
-- because they run barely 3,000. Utilisation, not asset age, is the lever.
-- ============================================================================
