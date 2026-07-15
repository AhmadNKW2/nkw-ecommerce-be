export type AnalyticsNamedValue = {
  name: string;
  value: number;
};

export type AnalyticsTimePoint = {
  date: string;
  activeUsers: number;
  sessions: number;
  pageViews: number;
  engagedSessions: number;
};

export type AnalyticsKpi = {
  label: string;
  key: string;
  value: number;
  previousValue: number;
  changePercent: number | null;
  format: 'number' | 'percent' | 'duration' | 'decimal';
};

export type AnalyticsOverview = {
  propertyId: string;
  range: {
    startDate: string;
    endDate: string;
    previousStartDate: string;
    previousEndDate: string;
    label: string;
  };
  kpis: AnalyticsKpi[];
  timeseries: AnalyticsTimePoint[];
  topPages: AnalyticsNamedValue[];
  trafficSources: AnalyticsNamedValue[];
  devices: AnalyticsNamedValue[];
  countries: AnalyticsNamedValue[];
  events: AnalyticsNamedValue[];
};
