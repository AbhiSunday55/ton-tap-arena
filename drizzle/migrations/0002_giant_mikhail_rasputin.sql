CREATE TABLE "leaderboard_seed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"avatar" text DEFAULT '⛏️' NOT NULL,
	"week_coin_mined" bigint DEFAULT 0 NOT NULL,
	"league_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "rule" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "rule_value" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_profiles" ADD COLUMN "combo_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_profiles" ADD COLUMN "last_tap_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "leaderboard_seed_week_idx" ON "leaderboard_seed" USING btree ("week_coin_mined");