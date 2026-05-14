export type AqiResult = {
  value: number;
  label: string;
  color: string;
  textColor: string;
  colorKey: string;
  advice: string;
};

export type SourceName =
  | 'Air4Thai, Pollution Control Department, Thailand'
  | 'AirGradient'
  | 'CUSense, Chulalongkorn University';

export type ObservedAt = {
  date: string | null;
  time: string | null;
};

export type UnifiedStation = {
  source: SourceName;
  stationID: string | null;
  nameTH: string | null;
  nameEN: string | null;
  areaTH: string | null;
  areaEN: string | null;
  lat: number | null;
  lon: number | null;
  pm25: number | null;
  aqi: AqiResult | null;
  observedAt: ObservedAt;
  timezone: string | null;
  imageKey: string;
  imageKeySelected: string;
};

export type PollutantReading = {
  value: number | null;
  unit: string;
};

export type EnvironmentReadings = {
  temperature: number | null;
  humidity: number | null;
  co2: number | null;
  tvoc: number | null;
  tvocIndex: number | null;
  noxIndex: number | null;
  heatIndex: number | null;
};

export type StationCurrent = {
  aqi: AqiResult | null;
  pollutants: {
    pm1: PollutantReading;
    pm25: PollutantReading;
    pm10: PollutantReading;
    o3: PollutantReading;
    co: PollutantReading;
    no2: PollutantReading;
    so2: PollutantReading;
  };
  environment: EnvironmentReadings;
};

export type HistoryPoint = {
  observedAtUtc: string | null;
  local: ObservedAt;
  aqi: number | null;
  pm1: number | null;
  pm25: number | null;
  pm10: number | null;
  temperature: number | null;
  humidity: number | null;
};

export type StationDetail = Omit<UnifiedStation, 'pm25' | 'aqi'> & {
  observedAtUtc: string | null;
  current: StationCurrent;
  history24h: HistoryPoint[];
};

export type StationSnapshot = {
  stationID: string;
  source: SourceName;
  observedAtUtc: string | null;
  local: ObservedAt;
  aqi: number | null;
  pm1: number | null;
  pm25: number | null;
  pm10: number | null;
  temperature: number | null;
  humidity: number | null;
};

export type AllResponse = {
  updateAt: string;
  count: number;
  countBySource: Record<string, number>;
  markerKeyCount: number;
  markerKeys: string[];
  sprite: { baseUrl: string };
  stations: UnifiedStation[];
  warnings?: string[];
};

export type FetchAllResult = {
  warnings: string[];
  countBySource: Record<string, number>;
  stations: UnifiedStation[];
  detailsByStationID: Record<string, StationDetail>;
};

export type SpriteIndexEntry = {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
};
