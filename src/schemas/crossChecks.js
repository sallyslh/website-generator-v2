// Checks that relate several JSON files to each other.
// Each input is optional; a check is skipped when a file it needs is missing.
// Returns a list of readable problem strings (empty list = all good).

export function crossCheck({ brief, assets, design, content } = {}) {
  const problems = [];

  if (brief && design) {
    const briefSlugs = brief.pages.map((p) => p.slug);
    const designSlugs = design.pages.map((p) => p.slug);
    for (const slug of briefSlugs)
      if (!designSlugs.includes(slug)) problems.push(`design-spec is missing page "${slug}" (it is in site-brief)`);
    for (const slug of designSlugs)
      if (!briefSlugs.includes(slug)) problems.push(`design-spec has page "${slug}" that is not in site-brief`);
  }

  if (design) {
    const seen = new Set();
    for (const page of design.pages)
      for (const section of page.sections)
        for (const slot of section.slots) {
          if (seen.has(slot.id)) problems.push(`duplicate slot id "${slot.id}"`);
          seen.add(slot.id);
        }
  }

  if (design && assets) {
    const assetIds = new Set(assets.assets.map((a) => a.id));
    for (const page of design.pages)
      for (const section of page.sections)
        for (const slot of section.slots)
          if (slot.assignedAsset && !assetIds.has(slot.assignedAsset))
            problems.push(`slot "${slot.id}" uses asset "${slot.assignedAsset}" which is not in asset-manifest`);
  }

  if (design && content) {
    for (const page of design.pages) {
      const cPage = content.pages.find((p) => p.slug === page.slug);
      if (!cPage) {
        problems.push(`content-spec is missing page "${page.slug}"`);
        continue;
      }
      const designIds = page.sections.map((s) => s.id);
      const contentIds = cPage.sections.map((s) => s.id);
      for (const id of designIds)
        if (!contentIds.includes(id)) problems.push(`content-spec page "${page.slug}" is missing section "${id}"`);
      for (const id of contentIds)
        if (!designIds.includes(id)) problems.push(`content-spec page "${page.slug}" has unknown section "${id}"`);
    }
    for (const cPage of content.pages)
      if (!design.pages.some((p) => p.slug === cPage.slug))
        problems.push(`content-spec has page "${cPage.slug}" that is not in design-spec`);
  }

  return problems;
}
