import { GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { GraphQLJSONObject } from 'graphql-type-json';

import { Account } from '../interface/Account';

export const VirtualCard = new GraphQLObjectType({
  name: 'VirtualCard',
  description: 'VirtualCard related properties.',
  fields: () => ({
    id: { type: GraphQLString },
    account: {
      type: Account,
      resolve(virtualCard, _, req) {
        if (virtualCard.CollectiveId) {
          return req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        }
      },
    },
    host: {
      type: Account,
      resolve(virtualCard, _, req) {
        if (virtualCard.HostCollectiveId) {
          return req.loaders.Collective.byId.load(virtualCard.HostCollectiveId);
        }
      },
    },
    userAccount: {
      type: Account,
      async resolve(virtualCard, _, req) {
        if (!virtualCard.UserId) {
          return null;
        }

        const user = await req.loaders.User.byId.load(virtualCard.UserId);
        if (user && user.CollectiveId) {
          const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
          if (collective && !collective.isIncognito) {
            return collective;
          }
        }
      },
    },
    name: {
      type: GraphQLString,
      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.name;
        }
      },
    },
    last4: {
      type: GraphQLString,

      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.last4;
        }
      },
    },
    data: {
      type: GraphQLJSONObject,
      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.data;
        }
      },
    },
    privateData: {
      type: GraphQLJSONObject,
      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.get('privateData');
        }
      },
    },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
  }),
});
