import { getSnkrdunkLastSoldByGrade } from "./scraper";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: trackedCards, error } = await supabase
    .from("tracked_cards")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("Failed to fetch tracked cards:", error);
    return;
  }

  if (!trackedCards.length) {
    console.error("No tracked cards found");
    return;
  }

  for (const card of trackedCards) {
    try {
      const result = await getSnkrdunkLastSoldByGrade(card);

      if (result.type === "RESOLVED") {
        await supabase.from("price_cache").upsert({
          card_query: card,
          source: "snkrdunk",
          price_data: result,
          updated_at: new Date().toISOString(),
        });

        console.log("Updated:", card);
      } else {
        console.warn(
          "Ambiguous search, skipped:",
          card,
          result.candidates.length,
          "candidates",
        );
      }
    } catch (err) {
      console.error("Failed:", card, err);
    }
  }
}

main();
