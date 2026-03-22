import { getSnkrdunkLastSoldByGrade } from './scraper';

function readQueryFromArgv(argv: string[]): string {
  const args = argv.slice(2).map((s) => s.trim()).filter(Boolean);
  if (args.length === 0) return '';
  return args.join(' ');
}

async function main() {
  const query = readQueryFromArgv(process.argv);
  if (!query) {
    console.error(
      'Usage: npm run scrape -- "<search text>" | "<trading-card id>" | "<product url>" | "<used listings url>"',
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = await getSnkrdunkLastSoldByGrade(query);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Scrape failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main();
