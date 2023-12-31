import { text, pgTable, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { user } from "./user";

export const goal = pgTable("goal", {
	goalId: serial("goalId").primaryKey(),
	title: text("title").notNull(),
	description: text("description"),
	priority: text("priority").default("medium"),
	relatedArea: text("relatedArea"),
	isDone: boolean("isDone").notNull().default(false),
	streak: integer("streak").notNull().default(0),
	access: text("access").default("private").notNull(),
	isActive: boolean("isActive").notNull().default(true),
	deadline: timestamp("deadline", { withTimezone: true }),
	createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow(),
	updatedAt: timestamp("updatedAt", { withTimezone: true }),
	streakUpdatedAt: timestamp("streakUpdatedAt"),
	order: serial("order"),
	userId: text("userId")
		.notNull()
		.references(() => user.userId),
});
