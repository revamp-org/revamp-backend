import { and, or, eq, like } from "drizzle-orm";
import db from "../../db";
import { community } from "../../db/schema/community";
import { goal } from "../../db/schema/goal";
import { userCommunity } from "../../db/schema/relations/user-community";
import { user } from "../../db/schema/user";
import { Community, MutationResolvers, QueryResolvers } from "../../generated/graphql";
import { YogaInitialContext } from "graphql-yoga";
import { getSession } from "../../middlewares/permissions";
import clerkClient from "@clerk/clerk-sdk-node";
import { goalShared } from "../../db/schema/relations/goal-share";
import { sqlToGqlGoal } from "./goal";
import { journalShared } from "../../db/schema/relations/journal-share";
import { journal } from "../../db/schema/journal";
import { sqlToGqlJournal } from "./journal";

export const getAllCommunities: QueryResolvers["communities"] = async () => {
	const sqlCommunities = await db.select().from(community);

	const gqlCommunities = await Promise.all(
		sqlCommunities.map(async sqlCommunity => await sqlToGqlCommunity(sqlCommunity)),
	);

	return gqlCommunities;
};

export const getMyCommunities: QueryResolvers["myCommunities"] = async (_, __, ctx) => {
	const session = await getSession(ctx.request.headers);
	const sqlCommunities = await db
		.select()
		.from(userCommunity)
		.innerJoin(community, eq(userCommunity.communityId, community.communityId))
		.where(eq(userCommunity.userId, session.userId));

	const gqlCommunities = await Promise.all(
		sqlCommunities.map(async sqlCommunity => await sqlToGqlCommunity(sqlCommunity.community)),
	);

	return gqlCommunities;
};

export const getSingleCommunityFunc = async (communityId: number): Promise<Community> => {
	const sqlCommunity = await db
		.select()
		.from(community)
		.where(eq(community.communityId, communityId));

	if (sqlCommunity.length === 0) throw new Error("Community does not exist");

	const gqlCommunity = await sqlToGqlCommunity(sqlCommunity[0]);

	return gqlCommunity;
};

export const getSingleCommunity: QueryResolvers["community"] = async (_, { communityId }) =>
	getSingleCommunityFunc(communityId);

export async function sqlToGqlCommunity(
	sqlCommunity: typeof community.$inferSelect,
): Promise<Community> {
	const usersArr = await db
		.select()
		.from(userCommunity)
		.innerJoin(user, eq(userCommunity.userId, user.userId))
		.where(
			and(
				eq(userCommunity.communityId, sqlCommunity.communityId),
				eq(userCommunity.status, "accepted"),
			),
		);

	const goals = await db
		.select()
		.from(goalShared)
		.innerJoin(goal, eq(goalShared.goalId, goal.goalId))
		.where(eq(goalShared.communityId, sqlCommunity.communityId));

	const goalsGql = await Promise.all(
		goals.map(async goal => {
			const goalGql = await sqlToGqlGoal(goal.goal);
			return goalGql;
		}),
	);

	const journalsFromDb = await db
		.select()
		.from(journalShared)
		.innerJoin(journal, eq(journalShared.journalId, journal.journalId))
		.where(eq(journalShared.communityId, sqlCommunity.communityId));

	const journals = await Promise.all(
		journalsFromDb.map(async journal => {
			const journalGql = await sqlToGqlJournal(journal.journal);
			return journalGql;
		}),
	);

	const gqlCommunity: Community = {
		...sqlCommunity,
		users: usersArr.map(user => ({
			user: { id: user.account.userId, ...user.account },
			role: user["user-community"].role,
		})),
		goals: goalsGql,
		journals,
	};
	return gqlCommunity;
}

export const searchCommunities: QueryResolvers["searchCommunities"] = async (
	_,
	{ searchString },
) => {
	const sqlCommunities = await db
		.select()
		.from(community)
		.where(
			or(
				like(community.community, searchString),
				like(community.description, searchString),
				like(community.communityId, searchString),
				like(community.nametag, searchString),
			),
		)
		.limit(10);

	const gqlCommunities = await Promise.all(
		sqlCommunities.map(async sqlCommunity => await sqlToGqlCommunity(sqlCommunity)),
	);

	return gqlCommunities;
};

export const createCommunity: MutationResolvers["createCommunity"] = async (
	_,
	args,
	ctx: YogaInitialContext,
) => {
	const session = await getSession(ctx.request.headers);
	const userFromClerk = { id: session.userId };
	if (!userFromClerk) throw new Error("You are not in the database");

	const communityId = await db
		.insert(community)
		.values({
			community: args.input.name,
			description: args.input.description,
			nametag: args.input.nametag,
			privacy: args.input?.privacy ?? "public",
		})
		.returning({ communityId: community.communityId });

	// admin
	await db.insert(userCommunity).values({
		userId: userFromClerk.id,
		communityId: communityId[0].communityId,
		role: "admin",
		status: "accepted",
	});

	// members
	for (const member of args.input.members) {
		await db.insert(userCommunity).values({
			userId: member,
			communityId: communityId[0].communityId,
			role: "member",
			status: "pending",
		});
	}

	return "Community created with id " + communityId[0].communityId;
};

export const acceptCommunityInvite: MutationResolvers["acceptCommunityInvite"] = async (
	_,
	{ communityId },
	ctx,
) => {
	const session = await getSession(ctx.request.headers);
	const userFromClerk = await clerkClient.users.getUser(session.userId);
	if (!userFromClerk) throw new Error("You are not in the database");

	db.update(userCommunity)
		.set({ status: "accepted" })
		.where(
			and(eq(userCommunity.communityId, communityId), eq(userCommunity.userId, userFromClerk.id)),
		);

	return "Community invite accepted";
};

export const declineCommunityInvite: MutationResolvers["declineCommunityInvite"] = async (
	_,
	{ communityId },
	ctx,
) => {
	const session = await getSession(ctx.request.headers);
	const userFromClerk = await clerkClient.users.getUser(session.userId);
	if (!userFromClerk) throw new Error("You are not in the database");

	await db
		.delete(userCommunity)
		.where(
			and(eq(userCommunity.communityId, communityId), eq(userCommunity.userId, userFromClerk.id)),
		);

	return "Community invite declined";
};

export const leaveCommunity: MutationResolvers["leaveCommunity"] = async (
	_,
	{ communityId },
	ctx,
) => {
	const session = await getSession(ctx.request.headers);
	const userFromClerk = await clerkClient.users.getUser(session.userId);
	if (!userFromClerk) throw new Error("You are not in the database");

	await db
		.delete(userCommunity)
		.where(
			and(eq(userCommunity.communityId, communityId), eq(userCommunity.userId, userFromClerk.id)),
		);

	return "Community left";
};

export const removeUserFromCommunity: MutationResolvers["removeUserFromCommunity"] = async (
	_,
	{ communityId, username },
) => {
	const userFromDb = await db
		.select({ userId: user.userId })
		.from(user)
		.where(eq(user.username, username));

	if (userFromDb.length === 0) throw new Error("User does not exist");
	const userId = userFromDb[0].userId;

	// check if user is not in community
	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	if (userInCommunityArr.length === 0) throw new Error("User is not in community");

	await db
		.delete(userCommunity)
		.where(and(eq(userCommunity.communityId, communityId), eq(userCommunity.userId, userId)));

	return "Community left";
};

export const inviteUserToCommunity: MutationResolvers["inviteUserToCommunity"] = async (
	_,
	{ communityId, username },
) => {
	const userFromDb = await db
		.select({ userId: user.userId })
		.from(user)
		.where(eq(user.username, username));

	if (userFromDb.length === 0) throw new Error("User does not exist");
	const userId = userFromDb[0].userId;

	// check if user is already in community
	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	if (userInCommunityArr.length !== 0) throw new Error("User is already in community");

	await db.insert(userCommunity).values({
		userId,
		communityId,
		role: "member",
	});

	return "User invited to community";
};

export const blockUserFromCommunity: MutationResolvers["blockUserFromCommunity"] = async (
	_,
	{ communityId, username },
) => {
	const userFromDb = await db
		.select({ userId: user.userId })
		.from(user)
		.where(eq(user.username, username));

	if (userFromDb.length === 0) throw new Error("User does not exist");
	const userId = userFromDb[0].userId;

	// check if user is already in community
	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	if (userInCommunityArr.length !== 0) {
		await db
			.update(userCommunity)
			.set({ status: "blocked" })
			.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));
	}

	await db.insert(userCommunity).values({
		userId,
		communityId,
		role: "member",
		status: "blocked",
	});

	return "User invited to community";
};

export const unBlockUserFromCommunity: MutationResolvers["unBlockUserFromCommunity"] = async (
	_,
	{ communityId, username },
) => {
	const userFromDb = await db
		.select({ userId: user.userId })
		.from(user)
		.where(eq(user.username, username));

	if (userFromDb.length === 0) throw new Error("User does not exist");
	const userId = userFromDb[0].userId;

	// check if user is already in community
	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	if (userInCommunityArr.length === 0) throw new Error("User is not in community to unblock");

	await db
		.update(userCommunity)
		.set({
			status: "accepted",
		})
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	return "User invited to community";
};

export const editCommunity: MutationResolvers["editCommunity"] = async (
	_,
	{ communityId, input },
) => {
	const communityArr = await db
		.select()
		.from(community)
		.where(eq(community.communityId, communityId));

	await db
		.update(community)
		.set({
			community: input.name ?? communityArr[0].community,
			description: input.description ?? communityArr[0].description,
			privacy: input.privacy ?? communityArr[0].privacy,
		})
		.where(eq(community.communityId, communityId));

	return "Community edited";
};

export const addUserToCommunity: MutationResolvers["addUserToCommunity"] = async (
	_,
	{ communityId, username },
) => {
	const userFromDb = await db
		.select({ userId: user.userId })
		.from(user)
		.where(eq(user.username, username));

	if (userFromDb.length === 0) throw new Error("User does not exist");

	const userId = userFromDb[0].userId;
	// check if user is already in community
	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	if (userInCommunityArr.length !== 0) throw new Error("User is already in community");

	await db.insert(userCommunity).values({
		userId,
		communityId,
		role: "member",
	});

	return "User added to community";
};

export const makeUserAdminOfCommunity: MutationResolvers["makeUserAdminOfCommunity"] = async (
	_,
	{ communityId, username },
) => {
	const userFromDb = await db
		.select({ userId: user.userId })
		.from(user)
		.where(eq(user.username, username));

	if (userFromDb.length === 0) throw new Error("User does not exist");
	const userId = userFromDb[0].userId;

	// check if user is not in community
	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	if (userInCommunityArr.length === 0) throw new Error("User is not in community");

	await db
		.update(userCommunity)
		.set({ role: "admin" })
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	return "User is now admin of community";
};

export const enterInCommunity: MutationResolvers["enterInCommunity"] = async (
	_,
	{ communityId },
	ctx,
) => {
	const session = await getSession(ctx.request.headers);
	const userFromClerk = await clerkClient.users.getUser(session.userId);
	if (!userFromClerk) throw new Error("You are not in the database");

	// check if user is already in community
	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(
			and(eq(userCommunity.userId, userFromClerk.id), eq(userCommunity.communityId, communityId)),
		);

	if (userInCommunityArr.length !== 0) throw new Error("User is already in community");

	const communityPrivacyArr = await db
		.select({ privacy: community.privacy })
		.from(community)
		.where(eq(community.communityId, communityId));

	if (communityPrivacyArr.length === 0) throw new Error("Community does not exist");

	if (communityPrivacyArr[0].privacy === "open") {
		await db.insert(userCommunity).values({
			userId: userFromClerk.id,
			communityId,
			role: "member",
			status: "accepted",
		});
	}

	await db.insert(userCommunity).values({
		userId: userFromClerk.id,
		communityId,
		role: "member",
		status: "requested",
	});

	return "User requested to enter community";
};
export const invitedUsersInCommunity: QueryResolvers["invitedUsersInCommunity"] = async (
	_,
	{ communityNametag },
	ctx,
) => {
	const communityIdArr = await db
		.select({ communityId: community.communityId })
		.from(community)
		.where(eq(community.nametag, communityNametag));
	if (communityIdArr.length === 0) throw new Error("Community does not exist");
	const communityId = communityIdArr[0].communityId;

	// check if admin
	const session = await getSession(ctx.request.headers);
	const userFromClerk = { id: session.userId };

	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(
			and(eq(userCommunity.userId, userFromClerk.id), eq(userCommunity.communityId, communityId)),
		);

	if (userInCommunityArr.length === 0) throw new Error("User is not in community");

	if (userInCommunityArr[0].role !== "admin") throw new Error("User is not admin of community");

	const invitedUsers = await db
		.select()
		.from(userCommunity)
		.innerJoin(user, eq(userCommunity.userId, user.userId))
		.where(and(eq(userCommunity.communityId, communityId), eq(userCommunity.status, "pending")));

	const invitedUsersGql = invitedUsers.map(user => ({
		...user.account,
		id: user.account.userId,
	}));

	return invitedUsersGql;
};

export const blockedUsersInCommunity: QueryResolvers["blockedUsersInCommunity"] = async (
	_,
	{ communityNametag },
	ctx,
) => {
	const communityIdArr = await db
		.select({ communityId: community.communityId })
		.from(community)
		.where(eq(community.nametag, communityNametag));
	if (communityIdArr.length === 0) throw new Error("Community does not exist");
	const communityId = communityIdArr[0].communityId;

	// check if admin
	const session = await getSession(ctx.request.headers);
	const userFromClerk = { id: session.userId };
	if (!userFromClerk) throw new Error("You are not in the database");

	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(
			and(eq(userCommunity.userId, userFromClerk.id), eq(userCommunity.communityId, communityId)),
		);

	if (userInCommunityArr.length === 0) throw new Error("User is not in community");

	if (userInCommunityArr[0].role !== "admin") throw new Error("User is not admin of community");

	const blockedUsers = await db
		.select()
		.from(userCommunity)
		.innerJoin(user, eq(userCommunity.userId, user.userId))
		.where(and(eq(userCommunity.communityId, communityId), eq(userCommunity.status, "blocked")));

	const invitedUsersGql = blockedUsers.map(user => ({
		...user.account,
		id: user.account.userId,
	}));

	return invitedUsersGql;
};

export const communityRequests: QueryResolvers["communityRequests"] = async (
	_,
	{ communityNametag },
	ctx,
) => {
	const communityIdArr = await db
		.select({ communityId: community.communityId })
		.from(community)
		.where(eq(community.nametag, communityNametag));
	if (communityIdArr.length === 0) throw new Error("Community does not exist");
	const communityId = communityIdArr[0].communityId;

	// check if admin
	const session = await getSession(ctx.request.headers);
	const userFromClerk = { id: session.userId };
	if (!userFromClerk) throw new Error("You are not in the database");

	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(
			and(eq(userCommunity.userId, userFromClerk.id), eq(userCommunity.communityId, communityId)),
		);

	if (userInCommunityArr.length === 0) throw new Error("User is not in community");

	if (userInCommunityArr[0].role !== "admin") throw new Error("User is not admin of community");

	const blockedUsers = await db
		.select()
		.from(userCommunity)
		.innerJoin(user, eq(userCommunity.userId, user.userId))
		.where(and(eq(userCommunity.communityId, communityId), eq(userCommunity.status, "requested")));

	const invitedUsersGql = blockedUsers.map(user => ({
		...user.account,
		id: user.account.userId,
	}));

	return invitedUsersGql;
};

export const communityInvitations: QueryResolvers["communityInvitations"] = async (_, __, ctx) => {
	const session = await getSession(ctx.request.headers);

	const userCommunityArr = await db
		.select()
		.from(userCommunity)
		.innerJoin(community, eq(userCommunity.communityId, community.communityId))
		.where(and(eq(userCommunity.userId, session.userId), eq(userCommunity.status, "pending")));

	const communities = await Promise.all(
		userCommunityArr.map(async community => {
			const communityGql = await sqlToGqlCommunity(community.community);
			return communityGql;
		}),
	);

	return communities;
};

export const requestedCommunities: QueryResolvers["requestedCommunities"] = async (_, __, ctx) => {
	const session = await getSession(ctx.request.headers);

	const userCommunityArr = await db
		.select()
		.from(userCommunity)
		.innerJoin(community, eq(userCommunity.communityId, community.communityId))
		.where(and(eq(userCommunity.userId, session.userId), eq(userCommunity.status, "requested")));

	const communities = await Promise.all(
		userCommunityArr.map(async community => {
			const communityGql = await sqlToGqlCommunity(community.community);
			return communityGql;
		}),
	);

	return communities;
};
