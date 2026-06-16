import { coerceModel } from "./model-io";
import type { DomainModel } from "./types";

/** A small, recognisable starter so the canvas is never empty on first open. */
export function sampleModel(): DomainModel {
  return coerceModel(
    {
      name: "Bookstore",
      version: 1,
      entities: [
        {
          name: "Author",
          color: "violet",
          description: "A person who writes books.",
          properties: [
            { name: "id", type: "uuid", primaryKey: true, required: true },
            { name: "name", type: "string", required: true },
            { name: "bio", type: "text" },
            { name: "born", type: "date" },
          ],
        },
        {
          name: "Book",
          color: "green",
          properties: [
            { name: "id", type: "uuid", primaryKey: true, required: true },
            { name: "title", type: "string", required: true },
            { name: "isbn", type: "string", unique: true },
            { name: "published", type: "date" },
            { name: "status", type: "enum", enumValues: ["draft", "published", "out_of_print"] },
            { name: "author_id", type: "ref", refEntityId: "Author" },
          ],
        },
        {
          name: "Review",
          color: "amber",
          properties: [
            { name: "id", type: "uuid", primaryKey: true, required: true },
            { name: "rating", type: "integer", required: true },
            { name: "body", type: "text" },
            { name: "created_at", type: "datetime" },
          ],
        },
      ],
      relations: [
        {
          name: "authorship",
          from: "Author",
          to: "Book",
          cardinality: "1-N",
          fromLabel: "writes",
          toLabel: "written by",
        },
        {
          name: "feedback",
          from: "Book",
          to: "Review",
          cardinality: "1-N",
          fromLabel: "has",
          toLabel: "for",
        },
      ],
    },
    { layout: true },
  );
}
