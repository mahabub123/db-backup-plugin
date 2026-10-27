// Prints the version the Release workflow should publish.
// Usage: node next-version.mjs <package.json version> <latest on npm> <patch|minor|major>
const [current, latest, bump] = process.argv.slice(2)

const parse = (version) => version.split('-')[0].split('.').map(Number)
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

// A version set by hand in package.json that is newer than npm is published as is.
if (compare(parse(current), parse(latest)) > 0) {
  console.log(current)
} else {
  const [major, minor, patch] = parse(latest)
  console.log(
    bump === 'major'
      ? `${major + 1}.0.0`
      : bump === 'minor'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`,
  )
}
