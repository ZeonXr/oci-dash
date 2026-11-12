import { expect, type Locator } from "@playwright/test";

async function openSelect(control: Locator): Promise<Locator> {
  await expect(control).toHaveAttribute("role", "combobox");
  await control.click();
  const listbox = control.page().getByRole("listbox");
  await expect(listbox).toBeVisible();
  return listbox;
}

/** Exercise the visible shadcn/Radix control, including its controlled value update. */
export async function selectOption(control: Locator, value: string | number): Promise<void> {
  const selected = String(value);
  const listbox = await openSelect(control);
  const option = listbox
    .getByRole("option")
    .and(listbox.locator(`[data-value=${JSON.stringify(selected)}]`));
  await option.click();
  await expect(control).toHaveAttribute("data-value", selected);
  await expect(listbox).not.toBeVisible();
}

/** Verify the choices users can actually open, rather than a hidden native select. */
export async function expectSelectOptions(control: Locator, labels: string[]): Promise<void> {
  const listbox = await openSelect(control);
  await expect(listbox.getByRole("option")).toHaveText(labels);
  await control.page().keyboard.press("Escape");
  await expect(listbox).not.toBeVisible();
}
