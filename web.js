const express = require('express')
const { graphqlHTTP } = require('express-graphql')
const gql = require('graphql')
const { Sequelize, Op } = require('sequelize')
const { resolver, attributeFields } = require('graphql-sequelize')
const models = require('./models/index.js')

const DomainType = new gql.GraphQLObjectType({
  name: 'Domain',
  fields: attributeFields(models.Name, {
    only: [
      'hash', 
      'name',
      'expiry',
      'owner',
      'createdAt',
      'updatedAt',
    ]
  })
})

const MAX_RESULTS = 200

// this adds some defaults to the basic graphql-sequelize
// resolver.
const customResolver = (model, resolveArgs) => {
  return resolver(model, {
    ...resolveArgs,
    before: (findOptions, args) => {
      if (resolveArgs.before) {
        findOptions = resolveArgs.before(findOptions, args)
      }
      if (!findOptions.limit) findOptions.limit = MAX_RESULTS
      if (findOptions.limit > MAX_RESULTS) findOptions.limit = MAX_RESULTS
      return findOptions
    }
  })
}

// these are default arguments to for pagination,
// ordering, etc.
const defaultArgs = {
  limit: {
    type: gql.GraphQLInt
  },
  order: {
    type: gql.GraphQLString
  },
  offset: {
    type: gql.GraphQLInt
  },
}

const schema = new gql.GraphQLSchema({
  query: new gql.GraphQLObjectType({
    name: 'Query',
    fields: {
      domainSearch: {
        type: new gql.GraphQLList(DomainType),
        args: {
          ...defaultArgs,
          query: { 
            description: 'Fuzzy-matched domain name',
            type: new gql.GraphQLNonNull(gql.GraphQLString) 
          }
        },
        resolve: customResolver(models.Name, {
          before: (findOptions, args) => {
            findOptions.where = {
              name: { [Op.like]: `%${args.query}%` },
            }
            if (!findOptions.order) findOptions.order = [['name', 'ASC']]
            return findOptions
          }
        })
      }
    }
  })
})

const main = async () => {
  const params = {
    dialect: 'sqlite'
  }
  const db = new Sequelize(params)
  await db.authenticate()

  const app = express()
  app.use('/graphql', graphqlHTTP({
    schema,
    graphiql: true
  }))

  app.listen(4000)
}

main()
