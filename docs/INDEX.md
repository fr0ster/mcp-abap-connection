# Documentation Index

## Package Structure

```
packages/connection/
├── README.md                 # Main package documentation
├── CHANGELOG.md             # Version history and changes
├── docs/                    # Detailed documentation
│   ├── INSTALLATION.md      # Setup and installation guide
│   ├── USAGE.md            # API documentation and examples
│   ├── AUTO_REFRESH_TESTING.md  # Testing guide for auto-refresh
│   └── CUSTOM_SESSION_STORAGE.md # Session storage implementation
├── examples/                # Working code examples
│   ├── README.md           # Examples overview
│   ├── basic-connection.js  # Simple connection example
│   ├── auto-refresh.js     # JWT auto-refresh demo
│   ├── session-persistence.js # FileSessionStorage usage
│   └── custom-session-storage.js # Custom storage implementation
└── src/                     # Source code
    └── __tests__/          # Unit tests
        └── auto-refresh.test.ts
```

## Quick Links

### Getting Started
- [Installation Guide](./INSTALLATION.md) - How to install and set up the package
- [Usage Guide](./USAGE.md) - Basic usage and API documentation

### Features
- [Auto-Refresh Testing](./AUTO_REFRESH_TESTING.md) - JWT token auto-refresh functionality
- [Custom Session Storage](./CUSTOM_SESSION_STORAGE.md) - Implementing custom session persistence

### Examples
- [Examples Overview](../examples/README.md) - All available examples
- [Basic Connection](../examples/basic-connection.js) - Simple connection
- [Auto-Refresh](../examples/auto-refresh.js) - Token refresh
- [Session Persistence](../examples/session-persistence.js) - Session management

## Documentation Standards

### File Organization
- **README.md** - Package overview, quick start, basic API
- **CHANGELOG.md** - All changes, following [Keep a Changelog](https://keepachangelog.com/)
- **docs/** - Detailed documentation, tutorials, guides
- **examples/** - Working code examples with README

### Naming Conventions
- `UPPERCASE.md` - Main documentation files (README, CHANGELOG)
- `PascalCase.md` - Detailed guides in docs/ folder
- `kebab-case.js` - Example files

### Content Guidelines
- Keep README concise, link to detailed docs
- Include working code examples
- Document environment variables and configuration
- Provide troubleshooting sections
- Show both success and error handling

## Contributing Documentation

When adding new features:
1. Update CHANGELOG.md with changes
2. Add usage examples to USAGE.md
3. Create working examples in examples/
4. Update README.md if API changes
5. Add troubleshooting to relevant guide
