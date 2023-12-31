import { sql, eq, and } from "drizzle-orm";
import db from "../../db";
import { comment } from "../../db/schema/comment";
import { journal } from "../../db/schema/journal";
import { goal } from "../../db/schema/goal";
import { Journal, Comment, Like, QueryResolvers, MutationResolvers } from "../../generated/graphql";
import { user } from "../../db/schema/user";
import { userLikesJournal } from "../../db/schema/relations/user-likes-journal";
import { YogaInitialContext } from "graphql-yoga";
import { getSession } from "../../middlewares/permissions";
import { workedOnLog } from "../../db/schema/worked-on-log";
import { checkIfToday, checkIfYesterday } from "../../lib/check-date";
import { dailyJournal } from "../../template/daily-journal";
import { journalShared } from "../../db/schema/relations/journal-share";
import { userCommunity } from "../../db/schema/relations/user-community";

const getCommentsOfJournal = async (journalId: number): Promise<Comment[]> => {
	const commentsFromDb = await db.select().from(comment).where(eq(comment.journalId, journalId));

	const comments: Comment[] = await Promise.all(
		commentsFromDb.map(async singleComment => {
			const authorInDb = await db.select().from(user).where(eq(user.userId, singleComment.userId));
			if (authorInDb.length === 0) throw new Error("Author not found");

			return {
				...singleComment,
				author: { ...authorInDb[0], id: authorInDb[0].userId },
			};
		}),
	);

	return comments;
};

const getJournalLikes = async (journalId: number): Promise<Like[]> => {
	const likesFromDb = await db
		.select()
		.from(userLikesJournal)
		.where(eq(userLikesJournal.journalId, journalId));

	const likes: Like[] = await Promise.all(
		likesFromDb.map(async singleLike => {
			const userFromDb = await db.select().from(user).where(eq(user.userId, singleLike.userId));
			if (userFromDb.length === 0) throw new Error("User not found");

			return {
				likedBy: { ...userFromDb[0], id: userFromDb[0].userId },
				likedAt: singleLike.likedAt,
			};
		}),
	);

	return likes;
};

export const sqlToGqlJournal = async (
	singleJournal: typeof journal.$inferSelect,
): Promise<Journal> => {
	const comments = await getCommentsOfJournal(singleJournal.journalId);
	const likes = await getJournalLikes(singleJournal.journalId);
	const createdByArr = await db.select().from(user).where(eq(user.userId, singleJournal.userId));

	return {
		...singleJournal,
		access: singleJournal.access || "private",
		comments,
		likedBy: likes,
		sharedBy: [],
		createdBy: { ...createdByArr[0], id: createdByArr[0].userId },
	};
};

export const getSingleJournal: QueryResolvers["getSingleJournal"] = async (
	_,
	{ journalId },
	ctx: YogaInitialContext,
) => {
	const journalFromDb = await db.select().from(journal).where(eq(journal.journalId, journalId));
	if (journalFromDb.length === 0) throw new Error("Journal not found");
	const session = await getSession(ctx.request.headers);

	if (session.userId !== journalFromDb[0].userId) throw new Error("Journal not found");

	return sqlToGqlJournal(journalFromDb[0]);
};

export const getTodayJournalDaily: QueryResolvers["todayJournalDaily"] = async (_, __, ctx) => {
	const session = await getSession(ctx.request.headers);
	const journalFromDb = (await db.execute(sql`
		SELECT * FROM journal WHERE ${journal.userId} = ${session.userId} AND DATE(${journal.date}) = CURRENT_DATE AND ${journal.type} = 'daily';
	`)) as (typeof journal.$inferSelect)[];

	if (journalFromDb.length === 0) throw new Error("Journal not created for today");

	return sqlToGqlJournal(journalFromDb[0]);
};

export const getJournalsOfUser: QueryResolvers["getJournalsOfUser"] = async (_, { userId }) => {
	const journalsFromDb = await db.select().from(journal).where(eq(journal.userId, userId));
	if (journalsFromDb.length === 0) throw new Error("No journals found");

	const journals: Journal[] = await Promise.all(
		journalsFromDb.map(async singleJournal => sqlToGqlJournal(singleJournal)),
	);

	return journals;
};

export const updateJournal: MutationResolvers["updateJournal"] = async (_, args, ctx) => {
	const session = await getSession(ctx.request.headers);

	const journalFromDb = await db
		.select()
		.from(journal)
		.where(eq(journal.journalId, args.journalId));

	if (journalFromDb.length === 0) throw new Error("Journal not found");

	if (journalFromDb[0].userId !== session.userId) throw new Error("Journal not found");

	await db.update(journal).set({
		title: args.title || journalFromDb[0].title,
		content: args.content || journalFromDb[0].content,
		isUpdated: true,
	});

	return "Journal updated successfully";
};

export const createOrUpdateJournalAutomated = async (userId: string, goalId: number) => {
	try {
		const workedOns = await db
			.select()
			.from(workedOnLog)
			.innerJoin(goal, eq(workedOnLog.goalId, goal.goalId))
			.where(and(eq(workedOnLog.goalId, goalId), eq(goal.userId, userId)));

		const workedOnToday = workedOns.filter(workedOn =>
			checkIfToday(workedOn["worked-on-log"].date),
		);
		const workedOnYesterday = workedOns.filter(workedOn =>
			checkIfYesterday(workedOn["worked-on-log"].date),
		);

		const completedTasks = await db
			.select()
			.from(goal)
			.where(and(eq(goal.userId, userId), eq(goal.isDone, true)));
		const completedTasksToday = completedTasks.filter(task => checkIfToday(task.updatedAt));
		const completedTasksYesterday = completedTasks.filter(task => checkIfYesterday(task.updatedAt));

		const journalText = await dailyJournal({
			userId,
			tasksCompletedToday: completedTasksToday.length,
			tasksCompletedYesterday: completedTasksYesterday.length,
			totalTasksToday: workedOnYesterday.length,
			yesterdayTotalTasks: workedOnToday.length,
		});

		const todayJournal = (await db.execute(
			sql`SELECT * FROM journal WHERE ${journal.userId} = ${userId} AND DATE(${journal.date}) = CURRENT_DATE;`,
		)) as (typeof journal.$inferSelect)[];

		if (todayJournal.length === 0) {
			await db.insert(journal).values({
				title: `Journal for ${new Date().toLocaleDateString()}`,
				userId,
				date: new Date(),
				type: "daily",
				content: journalText,
			});
		} else if (!todayJournal[0].isUpdated) {
			await db.update(journal).set({
				content: journalText,
			});
		}
	} catch (error) {
		if (error instanceof Error) {
			console.log(error.message);
		}
	}
};

export const shareJournal: MutationResolvers["shareJournal"] = async (_, args, ctx) => {
	const { journalId, communityId } = args;
	const session = await getSession(ctx.request.headers);

	// check if user is in the community
	const userInCommunity = await db
		.select()
		.from(userCommunity)
		.where(
			and(eq(userCommunity.communityId, communityId), eq(userCommunity.userId, session.userId)),
		);

	if (userInCommunity.length === 0) throw new Error("User not in community");

	if (userInCommunity[0].status !== "accepted") {
		throw new Error("User is not yet accepted in community");
	}

	await db.insert(journalShared).values({
		journalId,
		communityId,
		userId: session.userId,
	});

	return "Journal shared successfully in community with id " + communityId;
};

export const publishJournal: MutationResolvers["publishJournal"] = async (
	_,
	{ journalId },
	ctx,
) => {
	const session = await getSession(ctx.request.headers);

	await db
		.update(journal)
		.set({
			access: "public",
		})
		.where(and(eq(journal.journalId, journalId), eq(journal.userId, session.userId)));

	return "Journal published successfully";
};

export const likeJournal: MutationResolvers["likeJournal"] = async (_, { journalId }, ctx) => {
	const session = await getSession(ctx.request.headers);

	const journalFromDb = await db.select().from(journal).where(eq(journal.journalId, journalId));

	if (journalFromDb.length === 0) throw new Error("Journal not found");

	const userLikesJournalFromDb = await db
		.select()
		.from(userLikesJournal)
		.where(
			and(eq(userLikesJournal.journalId, journalId), eq(userLikesJournal.userId, session.userId)),
		);

	if (userLikesJournalFromDb.length !== 0) {
		await db
			.delete(userLikesJournal)
			.where(eq(userLikesJournal.likeId, userLikesJournalFromDb[0].likeId));

		return false;
	}

	await db.insert(userLikesJournal).values({
		journalId,
		userId: session.userId,
		likedAt: new Date(),
	});

	return true;
};
