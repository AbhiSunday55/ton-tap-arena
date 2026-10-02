CREATE TABLE "telegram_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_id" text NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"language_code" text,
	"is_premium" boolean DEFAULT false NOT NULL,
	"allows_write_to_pm" boolean DEFAULT false NOT NULL,
	"photo_url" text,
	"auth_date" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_profiles" ADD COLUMN "item_effects" jsonb DEFAULT '{"tapPercent":0,"energyCapBonus":0,"energyRegenPercent":0,"comboBonusPercent":0,"passivePerHour":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_items" ADD COLUMN "effects" jsonb DEFAULT '{"tapPercent":0,"energyCapBonus":0,"energyRegenPercent":0,"comboBonusPercent":0,"passivePerHour":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_accounts_tg_idx" ON "telegram_accounts" USING btree ("telegram_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_accounts_user_idx" ON "telegram_accounts" USING btree ("user_id");