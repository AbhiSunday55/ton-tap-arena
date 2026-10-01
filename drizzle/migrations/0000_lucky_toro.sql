CREATE TABLE "ad_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reward_coin" bigint DEFAULT 0 NOT NULL,
	"ad_unit_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"delta_coin" bigint DEFAULT 0 NOT NULL,
	"delta_nano_ton" bigint DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '🎯' NOT NULL,
	"kind" text DEFAULT 'task' NOT NULL,
	"reward_coin" bigint DEFAULT 0 NOT NULL,
	"bonus_nano_ton" bigint DEFAULT 0 NOT NULL,
	"cta_label" text DEFAULT 'Claim' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"avatar" text DEFAULT '⛏️' NOT NULL,
	"wallet_address" text,
	"wallet_provider" text,
	"wallet_public_key" text,
	"proof_verified_at" timestamp with time zone,
	"wallet_connected_at" timestamp with time zone,
	"balance_coin" bigint DEFAULT 0 NOT NULL,
	"balance_nano_ton" bigint DEFAULT 0 NOT NULL,
	"vested_nano_ton" bigint DEFAULT 0 NOT NULL,
	"locked_nano_ton" bigint DEFAULT 0 NOT NULL,
	"total_taps" bigint DEFAULT 0 NOT NULL,
	"total_coin_mined" bigint DEFAULT 0 NOT NULL,
	"week_coin_mined" bigint DEFAULT 0 NOT NULL,
	"week_start_at" timestamp with time zone DEFAULT now() NOT NULL,
	"energy" integer DEFAULT 1000 NOT NULL,
	"energy_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tap_power_level" integer DEFAULT 1 NOT NULL,
	"rigs_owned" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"item_boost_percent" integer DEFAULT 0 NOT NULL,
	"turbo_until" timestamp with time zone,
	"booster_day_key" text,
	"boosters_used" jsonb DEFAULT '{"turbo":0,"energy":0,"recharge":0}'::jsonb NOT NULL,
	"recharge_ready_at" timestamp with time zone,
	"streak_day" integer DEFAULT 0 NOT NULL,
	"streak_claimed_day_key" text,
	"referral_code" text NOT NULL,
	"referred_by" uuid,
	"referral_premium" boolean DEFAULT false NOT NULL,
	"equipped_skin" text DEFAULT 'skin_common' NOT NULL,
	"equipped_button" text DEFAULT 'btn_common' NOT NULL,
	"sound_enabled" boolean DEFAULT true NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_seed" boolean DEFAULT false NOT NULL,
	"withdrawal_pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_slug" text NOT NULL,
	"item_name" text NOT NULL,
	"category" text NOT NULL,
	"tier" text NOT NULL,
	"price_usdt_cents" integer NOT NULL,
	"pay_currency" text DEFAULT 'TON' NOT NULL,
	"amount_nano_ton" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_id" uuid NOT NULL,
	"referee_id" uuid NOT NULL,
	"coins_awarded" bigint DEFAULT 0 NOT NULL,
	"nano_ton_awarded" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"tier_index" integer DEFAULT 0 NOT NULL,
	"tier" text DEFAULT 'Common' NOT NULL,
	"price_usdt_cents" integer DEFAULT 50 NOT NULL,
	"coin_price" bigint DEFAULT 0 NOT NULL,
	"boost_percent" integer DEFAULT 0 NOT NULL,
	"image_url" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tap_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"taps" integer NOT NULL,
	"coins_earned" bigint NOT NULL,
	"multiplier_bp" integer DEFAULT 10000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"offer_slug" text NOT NULL,
	"reward_coin" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ton_proof_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"payload" text DEFAULT '' NOT NULL,
	"domain" text DEFAULT '' NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"name" text,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_nano_ton" bigint NOT NULL,
	"fee_nano_ton" bigint DEFAULT 0 NOT NULL,
	"network_fee_nano_ton" bigint DEFAULT 0 NOT NULL,
	"net_nano_ton" bigint DEFAULT 0 NOT NULL,
	"vested_nano_ton" bigint DEFAULT 0 NOT NULL,
	"payout_address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"fail_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_views" ADD CONSTRAINT "ad_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_profiles" ADD CONSTRAINT "player_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_id_users_id_fk" FOREIGN KEY ("referee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tap_logs" ADD CONSTRAINT "tap_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completions" ADD CONSTRAINT "task_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_views_user_idx" ON "ad_views" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_expires_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "files_owner_idx" ON "files" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "files_created_idx" ON "files" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_user_idx" ON "ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_slug_idx" ON "offers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "offers_active_idx" ON "offers" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "player_profiles_referral_code_idx" ON "player_profiles" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "player_profiles_week_idx" ON "player_profiles" USING btree ("week_coin_mined");--> statement-breakpoint
CREATE INDEX "player_profiles_created_idx" ON "player_profiles" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "purchases_user_idx" ON "purchases" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_user_item_idx" ON "purchases" USING btree ("user_id","item_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_referee_idx" ON "referrals" USING btree ("referee_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_items_slug_idx" ON "shop_items" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "shop_items_category_idx" ON "shop_items" USING btree ("category","tier_index");--> statement-breakpoint
CREATE INDEX "tap_logs_user_idx" ON "tap_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_completions_user_offer_idx" ON "task_completions" USING btree ("user_id","offer_slug");--> statement-breakpoint
CREATE INDEX "task_completions_user_idx" ON "task_completions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ton_proof_nonces_expires_idx" ON "ton_proof_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "withdrawals_user_idx" ON "withdrawals" USING btree ("user_id","created_at");