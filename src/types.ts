export type BookingSource = "telegram" | "web";
export type AppointmentStatus = "booked" | "cancelled";

export interface MasterSettings {
  masterId: string;
  slotDurationMinutes: 30 | 45 | 60;
  bookingHorizonDays: number;
  cancelCutoffHours: number;
  timezone: string;
}

export interface WorkingRule {
  masterId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  isActive: boolean;
}

export interface ScheduleException {
  masterId: string;
  date: string;
  isClosed: boolean;
  customStartMinute: number | null;
  customEndMinute: number | null;
}
