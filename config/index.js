const configs = require('./config.json')
const config = configs[process.env.NODE_ENV || 'development']
module.exports = config
