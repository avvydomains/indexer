const ethers = require('ethers')
const fs = require('fs')
const { Sequelize, Op } = require('sequelize')
const models = require('./models/index.js')

const RPCS = {
  31337: {
    block: 0,
    url: 'http://localhost:8545'
  },
  43113: {
    block: 0,
    url: 'https://api.avax-test.network/ext/bc/C/rpc'
  },
  43114: {
    block: 14909991,
    //url: 'https://api.avax.network/ext/bc/C/rpc'
    url: 'https://nd-938-215-711.p2pify.com/1007924c86e62685a43d102d0c0b38dd/ext/bc/C/rpc',
  },
}

const CHAIN_ID = 43114
const RPC = RPCS[CHAIN_ID]
const RPC_URL = RPC.url
const MAX_BLOCKS = 2048
  

class Event {
  constructor(id, type, blockNumber, blockTimestamp, transactionIndex, args) {
    this.id = id
    this.type = type
    this.blockNumber = blockNumber
    this.blockTimestamp = blockTimestamp
    this.transactionIndex = transactionIndex
    this.args = args
  }

  static unserializeArgs(data) {
    let args = JSON.parse(data)
    for (let prop in args) {
      if (args[prop]._isBigNumber) {
        args[prop] = ethers.BigNumber.from(args[prop].data)
      }
    }
    return args
  }

  serializeArgs() {
    let args = {}
    for (let prop in this.args) {
      if (this.args[prop]._isBigNumber) {
        args[prop] = {
          _isBigNumber: true,
          data: this.args[prop].toString()
        }
      } else {
        args[prop] = this.args[prop]
      }
    }
    return JSON.stringify(args)
  }
}


class DB {
  async init(params) {
    this.db = new Sequelize(params)
    await this.db.authenticate()
    this.t = null
    this.enableTransactions = false
  }

  async startTransaction() {
    if (this.enableTransactions) {
      this.t = await this.db.transaction()
    }
  }

  async commitTransaction() {
    if (this.enableTransactions) {
      await this.t.commit()
    }
  }

  async rollbackTransaction() {
    if (this.enableTransactions) {
      await this.t.rollback()
    }
  }

  buildOpts() {
    const opts = {}
    if (this.t) opts.transaction = this.t
    return opts
  }

  async getCurrentBlock() {
    const block = await models.Block.findOne({ limit: 1, order: [['block', 'DESC']] })
    if (block) return block.block
    return null
  }

  async setCurrentBlock(block) {
    const inserted = await models.Block.create({ block })
    await models.Block.destroy({
      where: {
        block: {
          [Op.lt]: inserted.block
        }
      }
    }, this.buildOpts())
  }

  async upsertName(hash, params) {
    const name = await models.Name.findOne({
      where: {
        hash
      }
    })
    if (name) {
      await name.update(params, this.buildOpts())
    } else {
      await models.Name.create({
        hash,
        ...params
      }, this.buildOpts())
    }
  }

  async saveEvent(e) {
    const payload = {
      type: e.type,
      blockNumber: e.blockNumber,
      blockTimestamp: e.blockTimestamp,
      transactionIndex: e.transactionIndex,
      args: e.serializeArgs()
    }
    await models.Event.create(payload, this.buildOpts())
  }

  async getNextEvent() {
    const e = await models.Event.findOne({
      order: [
        ['blockNumber', 'ASC'],
        ['transactionIndex', 'ASC']
      ]
    })
    if (!e) return null
    return new Event(
      e.id,
      e.type,
      e.blockNumber,
      e.blockTimestamp,
      e.transactionIndex,
      Event.unserializeArgs(e.args)
    )
  }

  async removeEvent(e) {
    await models.Event.destroy({
      where: {
        id: e.id
      }
    })
  }
}


class Indexer {
  constructor(provider, avvy, db, dataSource) {
    this.provider = provider
    this.avvy = avvy
    this.db = db
    this.dataSource = dataSource
  }

  async executeDomainRegistration(e) {
    await this.db.upsertName(e.args.name.toString(), {
      owner: e.args.registrant,
      expiry: new Date((e.blockTimestamp + parseInt(e.args.leaseLength.toString())) * 1000)
    })
  }

  async executeDomainTransfer(e) {
    await this.db.upsertName(e.args.tokenId.toString(), {
      owner: e.args.to
    })
  }

  async executeRainbowTableReveal(e) {
    const hash = this.avvy.hash(e.args.hash)
    const name = await hash.lookup()
    await this.db.upsertName(e.args.hash.toString(), {
      name: name.name
    })
  }

  async executeEvent(e) {
    switch (e.type) {
      case "Domain.Register":
        await this.executeDomainRegistration(e)
        break

      case "Domain.Transfer":
        await this.executeDomainTransfer(e)
        break

      case "RainbowTable.Reveal":
        await this.executeRainbowTableReveal(e)
        break
    }
  }

  // Execute any unprocessed events which
  // have been stored in the database.
  async executeEvents() {
    while (true) {
      let e = await this.db.getNextEvent()
      if (!e) break
      await this.db.startTransaction()
      try {
        await this.executeEvent(e)
        await this.db.removeEvent(e)
        await this.db.commitTransaction()
      } catch (err) {
        await this.db.rollbackTransaction()
        console.log('execution err', err)
        process.exit(1)
      }
    }
  }

  // Given a set of events and a block which we 
  // have fetched data up until, we now attempt
  // to persist the events to the database &
  // then update the block number in the database.
  // If this fails, we roll back and retry for
  // the block range.
  //
  // This method returns true if successful.
  async saveEventsAndSetBlock(events, nextFromBlock) {
    await this.db.startTransaction()

    try {
      for (let i = 0; i < events.length; i += 1) {
        await this.db.saveEvent(events[i])
      }
      await this.db.setCurrentBlock(nextFromBlock)
      await this.db.commitTransaction()
    } catch (err) {
      console.log('err, rolling back')
      console.log(err)
      process.exit(0)
      await this.db.rollbackTransaction()
      return false
    }

    return true
  }

  // This is the main loop for the indexer. This
  // method follows the following process:
  //
  // 1. Execute any unprocessed events that are
  //    saved in the database.
  //
  // 2. Fetch logs for the next range of blocks.
  //    If we are behind the current block, this
  //    means parsing a batch of a maximum size.
  //    Otherwise this means checking up until
  //    the current block.
  //
  // 3. Extract "Events" from the logs which were
  //    retrieved. Persist these Events to the
  //    database & update the next block.
  async run() {
    while (true) {
      await this.executeEvents()
      let currBlock = await this.provider.getBlockNumber()
      let fromBlock = await this.db.getCurrentBlock()
      let last = false
      if (!fromBlock) fromBlock = RPC.block // this is the first block to parse, if we're starting over
      let toBlock = fromBlock + MAX_BLOCKS
      if (toBlock >= currBlock) {
        toBlock = currBlock
        last = true
      }
      let events = await this.dataSource.getEventsInRange(fromBlock, toBlock)
      this.saveEventsAndSetBlock(events, toBlock + 1)
    }
  }
}


class LogDataSource {
  constructor(provider, avvy) {
    this.provider = provider
    this.avvy = avvy
    this.blockCache = {}
  }

  async getBlock(blockNumber) {
    if (!this.blockCache[blockNumber]) {
      this.blockCache[blockNumber] = await this.provider.getBlock(blockNumber)
    }
    return this.blockCache[blockNumber]
  }

  async clearBlockCache() {
    this.blockCache = {}
  }

  // get all events in the block range
  // from a specific topic
  async getEventsByFilter(params) {
    let logs = await this.provider.getLogs(params.filter)
    let results = []

    // get all the blocks cached
    let blockNumbers = []
    for (let i = 0; i < logs.length; i += 1) {
      if (blockNumbers.indexOf(logs[i].blockNumber) === -1) {
        blockNumbers.push(logs[i].blockNumber)
      }
    }
    await Promise.all(blockNumbers.map(num => this.getBlock(num)))

    for (let i = 0; i < logs.length; i += 1) {
      let block = await this.getBlock(logs[i].blockNumber)
      results.push(new Event(
        null, // no ID until we persist to db
        params.type,
        logs[i].blockNumber,
        block.timestamp,
        logs[i].transactionIndex,
        params.iface.parseLog(logs[i]).args
      ))
    }
    return results
  }

  // get all events in the block range
  async getEventsInRange(fromBlock, toBlock) {
    let params = [
      {
        type: 'Domain.Register',
        filter: { 
          topics: [
            ethers.utils.id('Register(address,address,uint256,uint256)')
          ], 
          address: this.avvy.contracts.Domain.address 
        },
        iface: this.avvy.contracts.Domain.interface
      },
      {
        type: 'Domain.Transfer',
        filter: {
          topics: [
            ethers.utils.id('Transfer(address,address,uint256)')
          ],
          address: this.avvy.contracts.Domain.address
        },
        iface: this.avvy.contracts.Domain.interface
      },
      {
        type: 'RainbowTable.Reveal',
        filter: {
          topics: [
            ethers.utils.id('Revealed(uint256)')
          ],
          address: this.avvy.contracts.RainbowTableV1.address
        },
        iface: this.avvy.contracts.RainbowTableV1.interface
      }
    ]
    let events = []

    for (let i = 0; i < params.length; i += 1) {
      let param = params[i]
      param.filter.fromBlock = fromBlock
      param.filter.toBlock = toBlock
      let result = await this.getEventsByFilter(param)
      events = events.concat(result)
    }

    return events
  }
}

const main = async () => {
  const _AVVY = await import('@avvy/client')
  const AVVY = _AVVY.default
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const db = new DB()
  await db.init({
    dialect: 'sqlite',
  })
  const avvy = new AVVY(provider, {
    chainId: CHAIN_ID
  })
  const dataSource = new LogDataSource(provider, avvy, db)
  const indexer = new Indexer(provider, avvy, db, dataSource)
  await indexer.run()
}

main().then(() => process.exit(0)).catch(err => {
  console.log(err)
  process.exit(1)
})
