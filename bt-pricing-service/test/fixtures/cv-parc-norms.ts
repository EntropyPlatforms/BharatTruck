// CV-Parc reference data copied VERBATIM from supabase/migrations/
// 0018_vehicle_cost_norms.sql (only the bs6/bs4 columns the pricing cost floor
// reads), the vehicle_service_cost_by_age curve, and the fleet_cost_settings
// global-default row. Same pattern as bt-fleet-service/test/economics.test.mts:
// this fixture fails if the formula OR the seed drifts from the founder workbook.
import type { CostNorms, ConsumablePrices } from '../../src/lib/cost-engine.js'

export const CV_PARC_NORMS: CostNorms[] = [
  {
    model_category: 'SCV Cargo', super_category: 'SCV Cargo', vehicle_class: 'SCV',
    kms_per_year: 24000, payload_tons_typical: 1.5, volume_cuft_typical: 300,
    kmpl_bs6: 14.92, kmpl_bs4: null, def_pct_bs6: 0.0346, def_pct_bs4: 0,
    eng_oil_km_bs6: 20000, eng_oil_km_bs4: 10000, eng_oil_l_bs6: 4.5, eng_oil_l_bs4: 3.0,
    gear_oil_km_bs6: 120000, gear_oil_km_bs4: 80000, gear_oil_l_bs6: 2.4, gear_oil_l_bs4: 1.3,
    tyre_cost_per_km: 0.35,
  },
  {
    model_category: 'Pickups', super_category: 'PU', vehicle_class: 'SCV',
    kms_per_year: 30000, payload_tons_typical: 1.0, volume_cuft_typical: 250,
    kmpl_bs6: 14.92, kmpl_bs4: null, def_pct_bs6: 0.0346, def_pct_bs4: 0,
    eng_oil_km_bs6: 20000, eng_oil_km_bs4: 10000, eng_oil_l_bs6: 7.5, eng_oil_l_bs4: 6.54,
    gear_oil_km_bs6: 20000, gear_oil_km_bs4: 10000, gear_oil_l_bs6: 4.1, gear_oil_l_bs4: 2.7,
    tyre_cost_per_km: 0.30,
  },
  {
    model_category: 'LCV (4-7 T)', super_category: 'LCV Cargo', vehicle_class: 'LCV',
    kms_per_year: 40000, payload_tons_typical: 6.0, volume_cuft_typical: 1050,
    kmpl_bs6: 7.31, kmpl_bs4: null, def_pct_bs6: 0.0196, def_pct_bs4: 0,
    eng_oil_km_bs6: 80000, eng_oil_km_bs4: 60000, eng_oil_l_bs6: 11.0, eng_oil_l_bs4: 9.0,
    gear_oil_km_bs6: 120000, gear_oil_km_bs4: 80000, gear_oil_l_bs6: 6.3, gear_oil_l_bs4: 5.7,
    tyre_cost_per_km: 0.70,
  },
  {
    model_category: 'ICV Cargo (Upto 14T)', super_category: 'ICV Cargo', vehicle_class: 'LCV',
    kms_per_year: 56000, payload_tons_typical: 14.0, volume_cuft_typical: 1260,
    kmpl_bs6: 6.23, kmpl_bs4: null, def_pct_bs6: 0.0324, def_pct_bs4: 0,
    eng_oil_km_bs6: 80000, eng_oil_km_bs4: 60000, eng_oil_l_bs6: 12.0, eng_oil_l_bs4: 11.0,
    gear_oil_km_bs6: 160000, gear_oil_km_bs4: 120000, gear_oil_l_bs6: 12.0, gear_oil_l_bs4: 10.0,
    tyre_cost_per_km: 1.00,
  },
  {
    model_category: 'MCV Cargo (15-19T)', super_category: 'MHCV Cargo', vehicle_class: 'MCV',
    kms_per_year: 66000, payload_tons_typical: 17.0, volume_cuft_typical: 1500,
    kmpl_bs6: 4.98, kmpl_bs4: 5.0, def_pct_bs6: 0.0508, def_pct_bs4: 0.0197,
    eng_oil_km_bs6: 80000, eng_oil_km_bs4: 60000, eng_oil_l_bs6: 22.5, eng_oil_l_bs4: 20.0,
    gear_oil_km_bs6: 160000, gear_oil_km_bs4: 120000, gear_oil_l_bs6: 9.6, gear_oil_l_bs4: 7.8,
    tyre_cost_per_km: 1.40,
  },
  {
    model_category: 'HCV Cargo 25-31T', super_category: 'MHCV Cargo', vehicle_class: 'HCV',
    kms_per_year: 72000, payload_tons_typical: 28.0, volume_cuft_typical: 2048,
    kmpl_bs6: 4.03, kmpl_bs4: 4.13, def_pct_bs6: 0.0464, def_pct_bs4: 0.0315,
    eng_oil_km_bs6: 120000, eng_oil_km_bs4: 80000, eng_oil_l_bs6: 24.5, eng_oil_l_bs4: 21.5,
    gear_oil_km_bs6: 160000, gear_oil_km_bs4: 120000, gear_oil_l_bs6: 9.75, gear_oil_l_bs4: 7.8,
    tyre_cost_per_km: 2.00,
  },
  {
    model_category: 'HCV Cargo 35-40T', super_category: 'MHCV Cargo', vehicle_class: 'HCV',
    kms_per_year: 72000, payload_tons_typical: 37.0, volume_cuft_typical: 2048,
    kmpl_bs6: 3.22, kmpl_bs4: 3.54, def_pct_bs6: 0.0526, def_pct_bs4: 0.0319,
    eng_oil_km_bs6: 120000, eng_oil_km_bs4: 80000, eng_oil_l_bs6: 25.0, eng_oil_l_bs4: 22.0,
    gear_oil_km_bs6: 160000, gear_oil_km_bs4: 120000, gear_oil_l_bs6: 11.2, gear_oil_l_bs4: 10.0,
    tyre_cost_per_km: 2.30,
  },
  {
    model_category: 'HCV Cargo 42-48T', super_category: 'MHCV Cargo', vehicle_class: 'HCV',
    kms_per_year: 72000, payload_tons_typical: 45.0, volume_cuft_typical: 2048,
    kmpl_bs6: 3.36, kmpl_bs4: 2.90, def_pct_bs6: 0.0545, def_pct_bs4: 0.0320,
    eng_oil_km_bs6: 120000, eng_oil_km_bs4: 80000, eng_oil_l_bs6: 25.0, eng_oil_l_bs4: 22.0,
    gear_oil_km_bs6: 160000, gear_oil_km_bs4: 120000, gear_oil_l_bs6: 13.2, gear_oil_l_bs4: 11.5,
    tyre_cost_per_km: 2.60,
  },
  {
    model_category: 'HCV Cargo 49-55T', super_category: 'MHCV Cargo', vehicle_class: 'HCV',
    kms_per_year: 72000, payload_tons_typical: 52.0, volume_cuft_typical: 2048,
    kmpl_bs6: 2.54, kmpl_bs4: 2.60, def_pct_bs6: 0.0556, def_pct_bs4: 0.0337,
    eng_oil_km_bs6: 120000, eng_oil_km_bs4: 80000, eng_oil_l_bs6: 25.0, eng_oil_l_bs4: 22.0,
    gear_oil_km_bs6: 160000, gear_oil_km_bs4: 120000, gear_oil_l_bs6: 13.2, gear_oil_l_bs4: 11.5,
    tyre_cost_per_km: 2.90,
  },
]

type ServiceRow = { super_category: string; age_years: number; annual_cost_inr: number }
const curve = (sc: string, costs: number[]): ServiceRow[] =>
  costs.map((c, i) => ({ super_category: sc, age_years: i + 1, annual_cost_inr: c }))

export const CV_PARC_SERVICE_CURVE: ServiceRow[] = [
  ...curve('MHCV Cargo', [108313, 186542, 209098, 195710, 140402, 107454, 79837, 72365, 86298, 60789]),
  ...curve('ICV Cargo', [58330, 89101, 87613, 66368, 62049, 43898, 33648, 32583, 32245, 28532]),
  ...curve('LCV Cargo', [31414, 41418, 38910, 32763, 31828, 20882, 19099, 18985, 18569, 16384]),
  ...curve('SCV Cargo', [24376, 36998, 35193, 41608, 43066, 32228, 21082, 21285, 27095, 27376]),
  ...curve('PU', [24376, 36998, 35193, 41608, 43066, 32228, 21082, 21285, 27095, 27376]),
]

// fleet_cost_settings global-default row (fleet_owner_id NULL).
export const FLEET_COST_SETTINGS_DEFAULT: ConsumablePrices = {
  diesel_price_inr: 90.0,
  def_price_inr: 45.0,
  engine_oil_price_inr: 420.0,
  gear_oil_price_inr: 390.0,
}
