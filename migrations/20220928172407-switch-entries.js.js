'use strict';

// StandardEntries and Entries were recorded in the wrong 
// databases to start. This resolves the issue.

module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
     await queryInterface.renameTable('Entries', 'TmpIntermediaryTable')
     await queryInterface.renameTable('StandardEntries', 'Entries')
     await queryInterface.renameTable('TmpIntermediaryTable', 'StandardEntries')
  },

  async down (queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
     await queryInterface.renameTable('Entries', 'TmpIntermediaryTable')
     await queryInterface.renameTable('StandardEntries', 'Entries')
     await queryInterface.renameTable('TmpIntermediaryTable', 'StandardEntries')
  }
};
