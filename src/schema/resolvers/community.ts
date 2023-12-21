import { and, eq } from "drizzle-orm";
import db from "../../db";
import { community } from "../../db/schema/community";
import { userCommunity } from "../../db/schema/relations/user-community";
import { Community, MutationResolvers, QueryResolvers } from "../../generated/graphql";
import { YogaInitialContext } from "graphql-yoga";
import { getSession } from "../../middlewares/permissions";
import clerkClient from "@clerk/clerk-sdk-node";

export const getAllCommunities: QueryResolvers["communities"] = async () => {
	const gqlCommunities: Community[] = [];
	return gqlCommunities;
};

export const getSingleCommunity: QueryResolvers["community"] = async (_, { communityId }) => {
	const sqlCommunity = await db
		.select()
		.from(community)
		.where(eq(community.communityId, communityId));

	if (sqlCommunity.length === 0) throw new Error("Community does not exist");

	const gqlCommunity = await sqlToGqlCommunity(sqlCommunity[0]);

	return gqlCommunity;
};

async function sqlToGqlCommunity(sqlCommunity: typeof community.$inferSelect): Promise<Community> {
	const communityWithUserArr = await db
		.select()
		.from(community)
		.innerJoin(userCommunity, eq(community.communityId, userCommunity.communityId))
		.where(eq(community.communityId, sqlCommunity.communityId));

	console.log(communityWithUserArr);

	throw new Error("Not implemented");
}

export const createCommunity: MutationResolvers["createCommunity"] = async (
	_,
	args,
	ctx: YogaInitialContext,
) => {
	const session = await getSession(ctx.request.headers);
	const userFromClerk = await clerkClient.users.getUser(session.userId);
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
		invite: "accepted",
	});

	// members
	for (const member of args.input.members) {
		await db.insert(userCommunity).values({
			userId: member,
			communityId: communityId[0].communityId,
			role: "member",
			invite: "pending",
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
		.set({ invite: "accepted" })
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
	{ communityId, userId },
) => {
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
	{ communityId, userId },
) => {
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
	{ communityId, userId },
) => {
	// check if user is already in community
	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	if (userInCommunityArr.length !== 0) {
		await db
			.update(userCommunity)
			.set({ invite: "blocked" })
			.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));
	}

	await db.insert(userCommunity).values({
		userId,
		communityId,
		role: "member",
		invite: "blocked",
	});

	return "User invited to community";
};

export const unBlockUserFromCommunity: MutationResolvers["unBlockUserFromCommunity"] = async (
	_,
	{ communityId, userId },
) => {
	// check if user is already in community
	const userInCommunityArr = await db
		.select()
		.from(userCommunity)
		.where(and(eq(userCommunity.userId, userId), eq(userCommunity.communityId, communityId)));

	if (userInCommunityArr.length === 0) throw new Error("User is not in community to unblock");

	await db
		.update(userCommunity)
		.set({
			invite: "accepted",
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
	{ communityId, userId },
) => {
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