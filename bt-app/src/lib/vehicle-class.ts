/**
 * Which vehicle class a load's weight needs. The weight picks the class on Post a Load
 * (2026-10-17): 50,000 kg cannot go on an LCV, so the selection moves up to the lightest class
 * that carries it. Payload ceilings, not gross vehicle weights — what the truck can actually load:
 *   mini truck (Tata Ace class)      to  1,500 kg
 *   LCV (407 / 709 / 14-ft)          to  7,000 kg
 *   HCV (10- to 14-wheel rigid)      to 25,000 kg
 *   trailer (multi-axle / flatbed)   above that — the top class; very heavy or over-dimensional
 *                                    cargo is still a trailer, arranged with the carrier.
 */

import type { PriceQuoteVehicleType } from './types'

export const VEHICLE_CLASS_LIMITS: Record<PriceQuoteVehicleType, number> = {
  mini_truck: 1_500,
  lcv: 7_000,
  hcv: 25_000,
  trailer: Number.POSITIVE_INFINITY,
}

const ORDER: PriceQuoteVehicleType[] = ['mini_truck', 'lcv', 'hcv', 'trailer']

/** The lightest class that carries `kg`; null when the weight is not a usable number yet. */
export function vehicleClassForWeight(kg: number): PriceQuoteVehicleType | null {
  if (!Number.isFinite(kg) || kg <= 0) return null
  return ORDER.find((c) => kg <= VEHICLE_CLASS_LIMITS[c]) ?? 'trailer'
}

/** Can this class take the weight? A blank or zero weight fits everything. */
export function canCarry(cls: PriceQuoteVehicleType, kg: number): boolean {
  if (!Number.isFinite(kg) || kg <= 0) return true
  return kg <= VEHICLE_CLASS_LIMITS[cls]
}
