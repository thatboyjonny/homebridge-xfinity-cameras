/** Loose shapes of what the xhome API returns. Only fields we rely on are typed. */

export interface Link {
  href: string;
  method?: string;
}

export interface Trouble {
  name: string;
  description?: string;
  criticality?: boolean;
  timestamp?: number;
}

export interface RawDevice {
  id: string;
  hardwareId?: string;
  deviceType: string;
  deviceSubtype?: string;
  name?: string;
  model?: string;
  manufacturer?: string;
  serialNumber?: string;
  firmwareVersion?: string;
  macAddress?: string;
  status?: string;
  trouble?: Trouble[];
  _links?: Record<string, Link | undefined>;
  properties?: Record<string, unknown>;
}

export interface DeltaEvent {
  commandId?: string | null;
  deviceId: string | null;
  mediaType: string;
  timestamp?: number;
  name?: string | null;
  value?: string | null;
  channel?: string | null;
  metadata?: Record<string, string | null | undefined>;
}

export interface ClientProfile {
  devices?: RawDevice[];
  xhomeProperties?: { hasIcontrolAccount?: boolean | null };
  sessionInfo?: { hasIcontrolAccount?: boolean | null; accountTier?: string };
}
