import clerkClient, { Session } from "@clerk/clerk-sdk-node";
import { GraphQLError } from "graphql";
import { shield, rule, and } from "graphql-shield";
import { YogaInitialContext } from "graphql-yoga";
import db from "../db";
import { user } from "../db/schema/user";
import { goal } from "../db/schema/goal";
import { userCommunity } from "../db/schema/relations/user-community";
import { eq, and as drizzleAnd } from "drizzle-orm";
import { setUserFunc } from "../schema/resolvers/user";

export const getSession = async (headers: Headers): Promise<Session> => {
	const sessionId = headers.get("authorization")?.split(" ")[1];
	if (!sessionId) throw new GraphQLError("No session id provided");

	const session = await clerkClient.sessions.getSession(sessionId);
	if (!session) throw new GraphQLError("Session not found");

	return session;
};

const isAuthenticated = rule()(async (_, args, context: YogaInitialContext) => {
	try {
		const session = await getSession(context.request.headers);
		const userFromClerk = await clerkClient.users.getUser(session.userId);

		const userFromDbArr = await db.select().from(user).where(eq(user.userId, session.userId));

		if (userFromDbArr.length === 0) {
			await setUserFunc(session.userId);
		}

		if (args.userId) {
			if (userFromClerk.id !== args.userId) {
				return new GraphQLError("User id does not match with the session user id");
			}
		}

		const expiryDate = new Date(session.expireAt);
		if (expiryDate < new Date()) return new GraphQLError("Session expired");

		return true;
	} catch (error) {
		if (error instanceof Error) {
			return new GraphQLError(error.message);
		}
		return new GraphQLError("Authorization Error");
	}
});

const isGoalOfUser = rule()(async (_, args, context: YogaInitialContext) => {
	try {
		const session = await getSession(context.request.headers);

		const userIdArr = await db
			.select({ userId: goal.userId })
			.from(goal)
			.where(eq(goal.goalId, args.goalId));

		const userId = userIdArr[0].userId;

		if (!userId) return new GraphQLError("Goal not found for the user");

		if (userId !== session.userId) return new GraphQLError("Goal not found for the user");

		return true;
	} catch (error) {
		if (error instanceof Error) {
			return new GraphQLError(error.message);
		}
		return new GraphQLError("Authorization Error");
	}
});

const isCommunityAdmin = rule()(async (_, args, context: YogaInitialContext) => {
	try {
		const session = await getSession(context.request.headers);
		const userFromClerk = await clerkClient.users.getUser(session.userId);
		if (!userFromClerk) throw new Error("You are not in the database");

		const userCommunityArr = await db
			.select()
			.from(userCommunity)
			.where(
				drizzleAnd(
					eq(userCommunity.communityId, args.communityId),
					eq(userCommunity.userId, userFromClerk.id),
					eq(userCommunity.role, "admin"),
				),
			);

		if (userCommunityArr.length === 0)
			return new GraphQLError("User is not an admin of the community");

		return true;
	} catch (error) {
		if (error instanceof Error) {
			return new GraphQLError(error.message);
		}
		return new GraphQLError("Authorization Error");
	}
});

const permissions = shield(
	{
		Query: {
			"*": isAuthenticated,
			getSingleGoal: and(isAuthenticated, isGoalOfUser),
		},
		Mutation: {
			"*": isAuthenticated,
			editGoal: and(isAuthenticated, isGoalOfUser),
			deleteGoal: and(isAuthenticated, isGoalOfUser),
			inviteUserToCommunity: and(isAuthenticated, isCommunityAdmin),
			blockUserFromCommunity: and(isAuthenticated, isCommunityAdmin),
			unBlockUserFromCommunity: and(isAuthenticated, isCommunityAdmin),
			removeUserFromCommunity: and(isAuthenticated, isCommunityAdmin),
			editCommunity: and(isAuthenticated, isCommunityAdmin),
			addUserToCommunity: and(isAuthenticated, isCommunityAdmin),
			makeUserAdminOfCommunity: and(isAuthenticated, isCommunityAdmin),
		},
	},
	{
		async fallbackError(error) {
			if (error instanceof GraphQLError) {
				return new GraphQLError(error.message);
			}

			return new GraphQLError("Authorization Error");
		},
	},
);

export default permissions;
