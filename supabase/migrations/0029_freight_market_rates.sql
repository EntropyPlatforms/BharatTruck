-- migration 0029: FR8-calibrated freight market rates (pricing-engine P2).
-- Source: founder BharatTruck_Test_Dataset_v3_FR8.xlsx (FR8.in live booked trips, June 2026).
-- The market layer of the pricing engine: a national ₹/km-by-class baseline plus per-corridor
-- lane rates + demand/supply ratio for the directional (backhaul) asymmetry. Additive; read-only
-- reference data seeded here, consumed by bt-pricing-service. Idempotent (truncate+reseed).

create table if not exists public.freight_market_rate_by_class (
  vehicle_class text primary key,
  inr_per_km numeric(8,2) not null,
  source text
);

create table if not exists public.freight_cities (
  city text primary key, lat numeric(9,6) not null, lng numeric(9,6) not null
);

create table if not exists public.freight_lane_rates (
  origin_city text not null, dest_city text not null,
  distance_km integer not null, nh text,
  mxl_inr integer, inr_per_km numeric(8,2), ds_ratio numeric(6,3),
  source text default 'FR8',
  primary key (origin_city, dest_city)
);

truncate table public.freight_market_rate_by_class;
truncate table public.freight_cities;
truncate table public.freight_lane_rates;

insert into public.freight_market_rate_by_class (vehicle_class, inr_per_km, source) values ('HCV', 62.86, 'FR8 median');
insert into public.freight_market_rate_by_class (vehicle_class, inr_per_km, source) values ('MCV', 92.39, 'FR8 median');
insert into public.freight_market_rate_by_class (vehicle_class, inr_per_km, source) values ('LCV', 92.39, 'FR8 median');
insert into public.freight_market_rate_by_class (vehicle_class, inr_per_km, source) values ('SCV', 68.91, 'FR8 median');

insert into public.freight_cities (city, lat, lng) values ('Mumbai', 19.076, 72.877);
insert into public.freight_cities (city, lat, lng) values ('Delhi', 28.614, 77.209);
insert into public.freight_cities (city, lat, lng) values ('Bangalore', 12.972, 77.595);
insert into public.freight_cities (city, lat, lng) values ('Kolkata', 22.573, 88.364);
insert into public.freight_cities (city, lat, lng) values ('Chennai', 13.083, 80.271);
insert into public.freight_cities (city, lat, lng) values ('Hyderabad', 17.385, 78.487);
insert into public.freight_cities (city, lat, lng) values ('Ahmedabad', 23.023, 72.572);
insert into public.freight_cities (city, lat, lng) values ('Pune', 18.52, 73.857);
insert into public.freight_cities (city, lat, lng) values ('Nagpur', 21.146, 79.088);
insert into public.freight_cities (city, lat, lng) values ('Jaipur', 26.912, 75.787);
insert into public.freight_cities (city, lat, lng) values ('Lucknow', 26.847, 80.947);
insert into public.freight_cities (city, lat, lng) values ('Patna', 25.594, 85.138);
insert into public.freight_cities (city, lat, lng) values ('Indore', 22.72, 75.858);
insert into public.freight_cities (city, lat, lng) values ('Bhubaneswar', 20.296, 85.825);
insert into public.freight_cities (city, lat, lng) values ('Visakhapatnam', 17.687, 83.219);
insert into public.freight_cities (city, lat, lng) values ('Guwahati', 26.145, 91.736);
insert into public.freight_cities (city, lat, lng) values ('Amritsar', 31.634, 74.872);
insert into public.freight_cities (city, lat, lng) values ('Surat', 21.17, 72.831);
insert into public.freight_cities (city, lat, lng) values ('Raipur', 21.251, 81.63);
insert into public.freight_cities (city, lat, lng) values ('Bhopal', 23.26, 77.413);
insert into public.freight_cities (city, lat, lng) values ('Coimbatore', 11.017, 76.956);
insert into public.freight_cities (city, lat, lng) values ('Kanpur', 26.45, 80.332);
insert into public.freight_cities (city, lat, lng) values ('Ludhiana', 30.901, 75.857);
insert into public.freight_cities (city, lat, lng) values ('Vijayawada', 16.507, 80.648);
insert into public.freight_cities (city, lat, lng) values ('Ranchi', 23.344, 85.31);
insert into public.freight_cities (city, lat, lng) values ('Jodhpur', 26.238, 73.024);
insert into public.freight_cities (city, lat, lng) values ('Agra', 27.177, 78.008);

insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mumbai','Delhi',1437,'NH48',85500,59.5,1.8);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Mumbai',1407,'NH48',50000,35.5,0.65);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Kolkata',1521,'NH19',86500,56.9,1.6);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Kolkata','Delhi',1540,'NH19',60350,39.2,0.7);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mumbai','Bangalore',964,'NH48',73000,75.7,1.85);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Bangalore','Mumbai',1029,'NH48',34000,33.0,0.45);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mumbai','Chennai',1319,'NH48',83000,62.9,1.55);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Chennai','Mumbai',1336,'NH48',57000,42.7,0.8);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Chennai',2186,'NH44',100000,45.7,1.5);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Chennai','Delhi',2249,'NH44',107000,47.6,1.1);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Bangalore',2189,'NH44',104500,47.7,1.45);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mumbai','Kolkata',2060,'NH53',126100,61.2,1.9);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Kolkata','Mumbai',2112,'NH53',69000,32.7,0.55);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Kolkata','Bangalore',1917,'NH16',76000,39.6,0.8);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Kolkata','Chennai',1695,'NH16',66500,39.2,0.75);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Chennai','Kolkata',1671,'NH16',97000,58.0,1.35);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Ahmedabad',961,'NH48',33250,34.6,0.55);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Ahmedabad','Delhi',998,'NH48',69000,69.1,1.45);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Ahmedabad','Mumbai',551,'NH48',42000,76.2,0.9);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mumbai','Surat',337,'NH48',25500,75.7,0.85);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mumbai','Pune',133,'NH48',25000,188.0,1.05);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Pune','Mumbai',161,'NH48',20200,125.5,0.95);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mumbai','Hyderabad',701,'NH65',57500,82.0,1.4);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Hyderabad','Mumbai',722,'NH65',34000,47.1,0.65);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Hyderabad','Bangalore',588,'NH44',38000,64.6,1.0);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Bangalore','Hyderabad',606,'NH44',32000,52.8,0.95);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Hyderabad','Chennai',660,'NH65',35500,53.8,0.85);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Chennai','Hyderabad',642,'NH65',40500,63.1,1.1);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Bangalore','Chennai',345,'NH48',18000,52.2,0.6);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Chennai','Bangalore',350,'NH48',31450,89.9,1.3);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Pune','Bangalore',859,'NH65',61500,71.6,1.25);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Hyderabad',1607,'NH44',84000,52.3,1.45);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Jaipur',289,'NH48',22750,78.7,1.0);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Lucknow',552,'NH27',37500,67.9,1.1);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Patna',1106,'NH19',75200,68.0,1.3);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Indore',842,'NH46',39000,46.3,0.9);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mumbai','Nagpur',807,'NH48',56000,69.4,1.2);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Kolkata','Guwahati',954,'NH27',74000,77.6,2.2);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Kolkata','Hyderabad',1465,'NH49',59600,40.7,0.9);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Guwahati','Kolkata',954,'NH27',40000,41.9,0.45);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Jaipur','Delhi',289,'NH48',19500,67.5,0.95);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Lucknow','Delhi',552,'NH27',28000,50.7,0.9);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Patna','Kolkata',600,'NH19',42000,70.0,0.85);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Chandigarh',250,'NH44',19000,76.0,1.0);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Amritsar',450,'NH44',29000,64.4,1.05);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Chennai','Coimbatore',490,'NH544',35000,71.4,1.1);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Coimbatore','Bangalore',360,'NH544',22000,61.1,0.85);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Nagpur','Mumbai',840,'NH48',35000,41.7,0.8);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Nagpur','Hyderabad',500,'NH44',30000,60.0,0.95);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Pune','Nagpur',720,'NH53',48000,66.7,1.2);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Kolkata','Bhubaneswar',480,'NH16',34000,70.8,1.05);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Bhubaneswar','Visakhapatnam',470,'NH16',30000,63.8,0.9);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Visakhapatnam','Kolkata',960,'NH16',44000,45.8,0.85);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Indore','Ahmedabad',400,'NH47',28000,70.0,1.05);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Surat','Nagpur',780,'NH53',45000,57.7,1.1);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mumbai','Goa',600,'NH66',42000,70.0,1.2);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Hyderabad','Delhi',1607,'NH44',48000,29.9,0.75);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Jamshedpur','Mumbai',1650,'NH49',70000,42.4,1.0);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Raipur','Nagpur',300,'NH53',21000,70.0,0.9);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Kochi','Bangalore',580,'NH544E',40000,69.0,1.05);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Mangalore','Bangalore',350,'NH75',22000,62.9,0.9);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Delhi','Haridwar',220,'NH334B',17000,77.3,0.95);
insert into public.freight_lane_rates (origin_city,dest_city,distance_km,nh,mxl_inr,inr_per_km,ds_ratio) values ('Ludhiana','Delhi',310,'NH44',22000,71.0,1.05);
