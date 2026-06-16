import { getLakehouseAnalyticsSummary, syncLakehouseFromPostgres } from "../server/lib/lakehouse";

async function main() {
  await syncLakehouseFromPostgres(100);
  const summary = await getLakehouseAnalyticsSummary();
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
