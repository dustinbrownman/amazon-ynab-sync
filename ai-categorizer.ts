import "dotenv/config";
import OpenAI from "openai";
import * as ynab from "ynab";

const OPENAI_ENABLED = process.env.OPENAI_ENABLED?.toLowerCase() === "true";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_EXCLUDED_CATEGORIES = process.env.OPENAI_EXCLUDED_CATEGORIES || "";

// Parse excluded categories from comma-separated list
const excludedCategoryNames = OPENAI_EXCLUDED_CATEGORIES.split(",")
  .map((name) => name.trim().toLowerCase())
  .filter((name) => name.length > 0);

let openai: OpenAI | null = null;

if (OPENAI_ENABLED) {
  if (!OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_ENABLED is set to true, but OPENAI_API_KEY is not provided"
    );
  }
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  if (excludedCategoryNames.length > 0) {
    console.log(
      `AI categorization will exclude categories: ${excludedCategoryNames.join(
        ", "
      )}`
    );
  }
}

interface CategoryMatch {
  categoryId: string;
  categoryName: string;
  reasoning: string;
}

export const isEnabled = (): boolean => OPENAI_ENABLED;

export const filterCategories = (
  categories: ynab.Category[]
): ynab.Category[] => {
  if (excludedCategoryNames.length === 0) {
    return categories;
  }

  const filtered = categories.filter(
    (category) => !excludedCategoryNames.includes(category.name.toLowerCase())
  );

  const excludedCount = categories.length - filtered.length;
  if (excludedCount > 0) {
    console.log(`Filtered out ${excludedCount} excluded categories`);
  }

  return filtered;
};

export const inferCategory = async (
  items: string[],
  categories: ynab.Category[]
): Promise<CategoryMatch | null> => {
  if (!OPENAI_ENABLED || !openai) {
    return null;
  }

  console.log("Inferring category...");

  // Filter out excluded categories
  const allowedCategories = filterCategories(categories);

  if (allowedCategories.length === 0) {
    console.error("No categories available after filtering exclusions");
    return null;
  }

  try {
    const categoryList = allowedCategories
      .map((c) => `- ${c.name} (ID: ${c.id})`)
      .join("\n");

    const itemList = items.map((item) => `- ${item}`).join("\n");

    const prompt = `You are a financial categorization assistant. Given a list of items from an Amazon order and a list of available budget categories, determine the most appropriate category for this purchase.

Amazon Order Items:
${itemList}

Available Categories:
${categoryList}

Please analyze the items and select the SINGLE most appropriate category. Consider:
1. The primary purpose of the items
2. If there are multiple items, choose the category that best represents the majority or most significant items
3. Be practical and choose categories that make sense for personal budgeting

Respond with a JSON object in this exact format:
{
  "categoryId": "the category ID",
  "categoryName": "the category name",
  "reasoning": "brief explanation of why this category was chosen"
}`;

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that categorizes purchases. Always respond with valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0].message.content;
    if (!content) {
      console.error("OpenAI returned empty response");
      return null;
    }

    const result = JSON.parse(content) as CategoryMatch;

    // Validate that the category ID exists in the allowed categories
    const categoryExists = allowedCategories.some(
      (c) => c.id === result.categoryId
    );
    if (!categoryExists) {
      console.error(
        `OpenAI returned invalid category ID: ${result.categoryId}`
      );
      return null;
    }

    console.log(
      `AI categorized [${items.join(", ")}] as "${result.categoryName}": ${
        result.reasoning
      }`
    );

    return result;
  } catch (error) {
    console.error("Error calling OpenAI API:", error);
    return null;
  }
};
