import { getSnkrdunkPrice } from "./scraper";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const trackedCards = [
    "Monkey.D.Luffy SEC-RSP OP13-118",
    "OP05 Zoro SR"
  ];

  for (const card of trackedCards) {
    try {
      const result = await getSnkrdunkPrice(card);

      if (result.type === "RESOLVED") {
        await supabase.from("price_cache").upsert({
          card_query: card,
          source: "snkrdunk",
          price_data: result,
          updated_at: new Date().toISOString()
        });

        console.log("Updated:", card);
      }

    } catch (err) {
      console.error("Failed:", card, err);
    }
  }
}

main();