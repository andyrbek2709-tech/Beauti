import dotenv from "dotenv";

dotenv.config();

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? "",
  timezone: env.TZ ?? "Europe/Moscow",
  bookingHorizonDays: Number(env.BOOKING_HORIZON_DAYS ?? 14),
  cancelCutoffHours: Number(env.CANCEL_CUTOFF_HOURS ?? 2),
  masterTelegramId: env.MASTER_TELEGRAM_ID ?? "",
  botToken: env.BOT_TOKEN ?? "",
  adminApiKey: env.ADMIN_API_KEY ?? "dev-admin-key",
  jwtSecret: env.JWT_SECRET ?? "dev-jwt-secret"
};

export function assertConfig(): void {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
}
