export default {
  testEnvironment: 'node',
  transform: {},
  roots: ['<rootDir>/test'],
  testPathIgnorePatterns: ['/node_modules/', '/backups/'],
  modulePathIgnorePatterns: ['<rootDir>/backups/'],
};
