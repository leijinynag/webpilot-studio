import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders its label and handles activation", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(<Button onClick={onClick}>Create project</Button>);

    const button = screen.getByRole("button", { name: "Create project" });
    await user.click(button);

    expect(onClick).toHaveBeenCalledOnce();
  });
});
