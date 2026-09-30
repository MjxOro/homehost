import type { SiteSpec } from "./schema";

export function fixture(): SiteSpec {
  return {
    version: 1,
    business: {
      name: "Cedar Grove Plumbing",
      niche: "Residential plumbing",
      phone: "+1 (250) 555-0147",
      email: "hello@cedargroveplumbing.ca",
      address: "184 Alder Street, Victoria, BC V8V 2A1, Canada",
      serviceArea: ["Victoria", "Oak Bay"],
      hours: [
        {
          days: ["mon", "tue", "wed", "thu", "fri"],
          opens: "08:00",
          closes: "17:00",
        },
      ],
      socials: [
        {
          kind: "Instagram",
          url: "https://www.instagram.com/cedargroveplumbing/",
        },
      ],
    },
    theme: { preset: "ocean", fonts: "modern" },
    pages: [
      {
        slug: "",
        title: "Cedar Grove Plumbing",
        description: "Neighbourhood plumbing in Victoria.",
        sections: [
          {
            type: "hero.centered",
            heading: "Plumbing with care",
            text: "Repairs and installations for your home.",
          },
        ],
      },
    ],
  };
}
