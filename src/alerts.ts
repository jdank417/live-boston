import type { Alert } from './mbta';

// Plain-language labels for MBTA alert effects and causes, and which alerts
// matter to someone riding right now.

const EFFECTS: Record<string, string> = {
  DELAY: 'Delays',
  SUSPENSION: 'Suspended',
  SHUTTLE: 'Shuttle buses',
  DETOUR: 'Detour',
  SERVICE_CHANGE: 'Service change',
  SCHEDULE_CHANGE: 'Schedule change',
  TRACK_CHANGE: 'Track change',
  STATION_CLOSURE: 'Station closed',
  STOP_CLOSURE: 'Stop closed',
  STOP_MOVE: 'Stop moved',
  STATION_ISSUE: 'Station issue',
  CANCELLATION: 'Cancelled',
  NO_SERVICE: 'No service',
  ELEVATOR_CLOSURE: 'Elevator out',
  ESCALATOR_CLOSURE: 'Escalator out',
  ACCESS_ISSUE: 'Access issue',
  PARKING_CLOSURE: 'Parking closed',
  PARKING_ISSUE: 'Parking issue',
  BIKE_ISSUE: 'Bike issue',
  NOTICE: 'Notice',
  EXTRA_SERVICE: 'Extra service',
  SNOW_ROUTE: 'Snow route',
  SUMMARY: 'Summary',
  POLICY_CHANGE: 'Policy change',
  FACILITY_ISSUE: 'Facility issue',
  AMBER_ALERT: 'Amber alert',
  DOCK_CLOSURE: 'Dock closed',
  DOCK_ISSUE: 'Dock issue',
  MODIFIED_SERVICE: 'Modified service',
  STOP_SHOVELING: 'Stop not cleared',
};

/**
 * Causes from outside the T itself: other railroads, the harbor, the weather.
 * These are the "what's affecting the MBTA" signals the alerts carry.
 */
const OUTSIDE_CAUSES: Record<string, string> = {
  FREIGHT_TRAIN_INTERFERENCE: 'Freight train',
  AMTRAK: 'Amtrak',
  AMTRAK_TRAIN_TRAFFIC: 'Amtrak traffic',
  DRAWBRIDGE_BEING_RAISED: 'Drawbridge raised',
  COAST_GUARD_RESTRICTION: 'Coast Guard',
  ROUGH_SEAS: 'Rough seas',
  TIDAL_RESTRICTION: 'Tides',
  FOG: 'Fog',
  HIGH_WINDS: 'High winds',
  SNOW_CONDITIONS: 'Snow',
  WEATHER: 'Weather',
  HEAT_RELATED_ISSUE: 'Heat',
  FLOODING: 'Flooding',
  TRAFFIC: 'Traffic',
  POLICE_ACTIVITY: 'Police activity',
  FIRE: 'Fire',
  FIRE_DEPARTMENT_ACTIVITY: 'Fire department',
  MEDICAL_EMERGENCY: 'Medical emergency',
  SPECIAL_EVENT: 'Special event',
  PARADE: 'Parade',
  DEMONSTRATION: 'Demonstration',
  ACCIDENT: 'Accident',
  POWER_PROBLEM: 'Power problem',
  CONSTRUCTION: 'Construction',
  MAINTENANCE: 'Maintenance',
  DISABLED_TRAIN: 'Disabled train',
  DISABLED_BUS: 'Disabled bus',
  SIGNAL_PROBLEM: 'Signal problem',
  SWITCH_PROBLEM: 'Switch problem',
  TRACK_PROBLEM: 'Track problem',
  SINGLE_TRACKING: 'Single tracking',
  SPEED_RESTRICTION: 'Speed restriction',
  MECHANICAL_PROBLEM: 'Mechanical problem',
  TECHNICAL_PROBLEM: 'Technical problem',
  HEAVY_RIDERSHIP: 'Heavy ridership',
  CREW_ISSUES: 'Crew issue',
};

/** Causes worth calling out because they come from beyond the MBTA's own system. */
export const EXTERNAL = new Set([
  'FREIGHT_TRAIN_INTERFERENCE',
  'AMTRAK',
  'AMTRAK_TRAIN_TRAFFIC',
  'DRAWBRIDGE_BEING_RAISED',
  'COAST_GUARD_RESTRICTION',
  'ROUGH_SEAS',
  'TIDAL_RESTRICTION',
]);

export function effectLabel(effect: string) {
  return EFFECTS[effect] ?? effect.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function causeLabel(cause: string): string | null {
  if (!cause || cause === 'UNKNOWN_CAUSE') return null;
  return OUTSIDE_CAUSES[cause] ?? cause.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Disruptions to riding, as opposed to notices and accessibility issues. */
const SERVICE = new Set([
  'DELAY',
  'SUSPENSION',
  'SHUTTLE',
  'DETOUR',
  'SERVICE_CHANGE',
  'TRACK_CHANGE',
  'STATION_CLOSURE',
  'STOP_CLOSURE',
  'STOP_MOVE',
  'CANCELLATION',
  'NO_SERVICE',
  'MODIFIED_SERVICE',
  'SCHEDULE_CHANGE',
  'DOCK_CLOSURE',
]);

const ACCESS = new Set(['ELEVATOR_CLOSURE', 'ESCALATOR_CLOSURE', 'ACCESS_ISSUE', 'STATION_ISSUE', 'FACILITY_ISSUE', 'DOCK_ISSUE']);

export type AlertKind = 'service' | 'access' | 'notice';

export function kindOf(a: Alert): AlertKind {
  if (SERVICE.has(a.effect)) return 'service';
  if (ACCESS.has(a.effect)) return 'access';
  return 'notice';
}

/** Severe enough to badge a line: the MBTA's own scale, 3 and up. */
export function isDisruptive(a: Alert) {
  return kindOf(a) === 'service' && a.severity >= 3;
}
