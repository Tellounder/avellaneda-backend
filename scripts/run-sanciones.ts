import { runSanctionsEngine } from '../src/services/sanctions.service';

const main = async () => {
  const result = await runSanctionsEngine();
  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

