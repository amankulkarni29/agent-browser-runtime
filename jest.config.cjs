module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest', {
      jsc: {
        parser: { syntax: 'typescript' },
        target: 'es2022'
      },
      module: { type: 'commonjs' }
    }]
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/cli.ts', '!src/adapters/**']
};
