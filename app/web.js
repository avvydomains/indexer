const fs = require('fs')
const http = require('http')
//const { createHandler } = require('graphql-http/lib/use/node')
const { createHandler } = require('graphql-http')
const gql = require('graphql')
const { Sequelize, Op } = require('sequelize')
const { resolver, attributeFields } = require('graphql-sequelize')
const models = require('./models/index.js')
const config = require('./config/index.js')

const isProd = process.env.NODE_ENV === 'production';
const graphiql = fs.readFileSync('graphiql.html', 'utf-8').replace('<% GRAPHQL_URL %>', process.env.GRAPHQL_URL)

const StandardRecordType = new gql.GraphQLObjectType({
  name: 'StandardRecord',
  fields: {
    ...attributeFields(models.StandardEntry, {
      only: [
        'key',
        'value',
      ]
    }),
  }
})

const CustomRecordType = new gql.GraphQLObjectType({
  name: 'CustomRecord',
  fields: {
    ...attributeFields(models.Entry, {
      only: [
        'key',
        'value',
        'name',
        'hash',
        'contractAddress',
      ]
    }),
  }
})

const ResolutionType = new gql.GraphQLObjectType({
  name: 'Resolution',
  fields: {
    resolverAddress: {
      type: gql.GraphQLString,
    },
    name: {
      type: gql.GraphQLString,
    },
    hash: {
      type: gql.GraphQLString,
    },
    standardRecords: {
      type: new gql.GraphQLList(StandardRecordType),
      resolve: async (resolver) => {
        const entries = await models.StandardEntry.findAll({
          where: {
            name: resolver.name,
            hash: resolver.hash,
            contractAddress: resolver.resolverAddress
          }
        })
        const output = entries.map((entry) => ({
          key: entry.key,
          value: entry.value
        }))
        return output
      }
    },
    customRecords: {
      type: new gql.GraphQLList(CustomRecordType),
      resolve: async (resolver) => {
        const entries = await models.Entry.findAll({
          where: {
            name: resolver.name,
            hash: resolver.hash,
            contractAddress: resolver.resolverAddress
          }
        })
        const output = entries.map((entry) => ({
          key: entry.key,
          value: entry.value
        }))
        return output
      }
    }
  }
})

const DomainType = new gql.GraphQLObjectType({
  name: 'Domain',
  fields: {
    ...attributeFields(models.Name, {
      only: [
        'hash', 
        'name',
        'expiry',
        'owner',
        'createdAt',
        'updatedAt',
      ]
    }),
    resolution: {
      type: ResolutionType,
      resolve: async (name) => {
        const reference = await models.ResolverReference.findOne({
          where: {
            name: name.hash,
            hash: name.hash
          }
        })
        if (!reference) {
          return null
        }
        const resolver = await models.Resolver.findOne({
          where: {
            id: reference.resolver
          }
        })
        if (!resolver) {
          return null
        }
        return {
          resolverAddress: resolver.address,
          name: name.hash,
          hash: name.hash,
        }
      }
    },
  }
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
      customRecords: {
        type: new gql.GraphQLList(CustomRecordType),
        args: {
          ...defaultArgs,
          key: {
            description: 'Exact match key',
            type: gql.GraphQLString
          }
        },
        resolve: customResolver(models.Entry, {
          before: (findOptions, args) => {
            if (args.key) {
              findOptions.where = {
                key: args.key
              }
            }
            return findOptions
          }
        })
      },
      domains: {
        type: new gql.GraphQLList(DomainType),
        args: {
          ...defaultArgs,
          search: { 
            description: 'Fuzzy-matched domain name',
            type: gql.GraphQLString
          },
          hash: {
            description: 'Hash of domain',
            type: gql.GraphQLString
          },
          expiryLessThan: {
            description: 'Filter by domains expiring before (exclusive) the given timestamp',
            type: gql.GraphQLString
          },
          expiryGreaterThan: {
            description: 'Filter by domains expiring after (exclusive) the given timestamp',
            type: gql.GraphQLString
          },
        },
        resolve: customResolver(models.Name, {
          before: (findOptions, args) => {
            const addToWhere = (opts) => {
              if (!findOptions.where) findOptions.where = {}
              findOptions.where = Object.assign(findOptions.where, opts)
            }

            if (args.search) {
              addToWhere({
                name: { [Op.like]: `%${args.search}%` },
              })
            }

            if (args.hash) {
              addToWhere({
                hash: args.hash
              })
            }

            if (args.expiryLessThan !== undefined && args.expiryGreaterThan !== undefined) {
              addToWhere({
                expiry: {
                  [Op.between]: [new Date(Date.parse(args.expiryGreaterThan)), new Date(Date.parse(args.expiryLessThan))]
                }
              })
            } else if (args.expiryLessThan !== undefined) {
              addToWhere({
                expiry: {
                  [Op.lt]: new Date(Date.parse(args.expiryLessThan))
                }
              })
            } else if (args.expiryGreaterThan !== undefined) {
              addToWhere({
                expiry: {
                  [Op.gt]: new Date(Date.parse(args.expiryGreaterThan))
                }
              })
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
  const db = new Sequelize(config)
  await db.authenticate()

  const handler = createHandler({ 
    schema,
  });
  const server = http.createServer((req, res) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'OPTIONS, POST, GET',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': 2592000, // 30 days
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (req.url.startsWith('/graphql')) {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(graphiql, 'utf-8')
        return
      } else {
        handler({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: () => {
            return new Promise((resolve) => {
              let body = ''
              req.on('data', chunk => body += chunk)
              req.on('end', () => {
                resolve(body)
              })
            })
          },
          raw: req,
          context: { res },
        }).then(([body, init]) => {
          res.writeHead(init.status, init.statusText, Object.assign(headers, init.headers)).end(body)
        }).catch(err => {
          if (isProd) {
            res.writeHead(500).end();
          } else {
            res
              .writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              .end(
                JSON.stringify({
                  errors: [
                    err instanceof Error
                      ? {
                          message: err.message,
                          stack: err.stack,
                        }
                      : err,
                  ],
                }),
              );
          }
        })
      }
    } else {
      res.writeHead(404).end();
    }
  });

  server.listen(process.env.WEB_PORT || 4000);
}

main()
