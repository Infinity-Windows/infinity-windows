import { expect,test,type Page } from "@playwright/test";
// Component-only fixture served by the existing isolated, non-resolving e2e host.
test.beforeEach(async({page})=>{
  await page.route("**/*",route=>{
    const url=new URL(route.request().url());
    return url.hostname==="localhost" || url.hostname==="127.0.0.1" ? route.continue() : route.abort();
  });
  await page.goto("/e2e/support/work-view.html");
  await expect(page.getByTestId("project-activity-view")).toBeVisible();
});
async function fits(page:Page){
  expect(await page.evaluate(()=>({overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),
    outside:[...document.querySelectorAll<HTMLElement>(".pav *")].filter(e=>e.getClientRects().length && (e.getBoundingClientRect().left<-.1 || e.getBoundingClientRect().right>innerWidth+.1)).map(e=>`${e.tagName}.${e.className}`)}))).toEqual({overflow:0,outside:[]});
  expect(await page.locator(".pav-project h1").evaluate(node=>node.getBoundingClientRect().height/parseFloat(getComputedStyle(node).lineHeight))).toBeLessThanOrEqual(2.05);
}
test("General and Specific controls fit phone portrait and landscape in both languages",async({page})=>{
  for(const locale of ["en","es"]){
    if(locale==="es")await page.getByRole("button",{name:"Change language",exact:true}).click();
    for(const scope of ["general","specific"]){
      await page.getByRole("tab",{name:scope==="general"?"General":locale==="en"?"Specific":"Específico",exact:true}).click();
      for(const viewport of [{width:320,height:720},{width:390,height:844},{width:844,height:390}]){
        await page.setViewportSize(viewport);await fits(page);
        if(viewport.width===390)await page.screenshot({path:test.info().outputPath(`${locale}-${scope}-390.png`),fullPage:true});
      }
    }
  }
});
test("dimension typing keeps focus and original values through unit/source/language changes",async({page})=>{
  await page.getByRole("tab",{name:"Specific",exact:true}).click();
  const width=page.getByLabel("Width",{exact:true});await width.pressSequentially("12.");await expect(width).toBeFocused();
  await page.getByLabel("Height",{exact:true}).fill(".75");await page.getByRole("combobox",{name:"Measurement unit",exact:true}).selectOption("ft");
  await page.getByRole("combobox",{name:"Dimension source",exact:true}).selectOption("estimated");
  await page.getByLabel("Source reference (optional)",{exact:true}).fill("😀".repeat(500));
  await page.getByRole("button",{name:"Change language",exact:true}).click();
  const inputs=page.locator(".dimension-observation input");await expect(inputs.nth(0)).toHaveValue("12.");await expect(inputs.nth(1)).toHaveValue(".75");await expect(inputs.nth(2)).toHaveValue("😀".repeat(500));
  await expect(page.locator(".dimension-observation-estimate")).toBeVisible();await expect(page.getByTestId("intent-count")).toHaveText("0");
});
test("machinery cancellation keeps work and selection sends one exact Specific intent",async({page})=>{
  const machine=page.getByRole("button",{name:"Moving heavy units using machinery",exact:true});await machine.click();
  await expect(page.getByRole("dialog")).toBeVisible();await expect(page.getByRole("button",{name:"Scissor Lift",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Cancel",exact:true}).click();await expect(page.getByTestId("intent-count")).toHaveText("0");
  await expect(page.locator(".pav-tile-running")).toHaveCount(1);
  await page.getByRole("tab",{name:"Specific",exact:true}).click();await expect(page.locator(".pav-tile-running")).toHaveCount(0);await machine.click();
  await page.setViewportSize({width:320,height:720});await fits(page);await page.getByRole("button",{name:"Scissor Lift",exact:true}).click();
  await expect(page.getByTestId("intent-count")).toHaveText("1");const intents=JSON.parse(await page.getByTestId("intent-json").innerText());
  expect(intents[0]).toMatchObject({scope:"specific",selectionRevision:2,machineKind:"scissor_lift",unit:{operationalRevision:5,factRevision:3,incarnationEpoch:1,bindingEpoch:2}});
  await expect(machine).toBeDisabled();
});
test("unknown totals stay unavailable and paid controls remain usable under refusal or pending",async({page})=>{
  await expect(page.getByRole("button",{name:"Checking floor and opening dimensions",exact:true})).toContainText("Unavailable");
  await page.getByRole("button",{name:"Toggle unavailable",exact:true}).click();await page.getByRole("button",{name:"Toggle pending",exact:true}).click();
  for(const name of ["Your clock","Break","Clock out","Schedule","Ask"]){const control=page.getByRole("button",{name,exact:true});await expect(control).toBeEnabled();await control.click();}
  await expect(page.getByTestId("controls-json")).toHaveText('["clock","break","out","schedule","ask"]');await expect(page.getByTestId("intent-count")).toHaveText("0");
});

test("published questions retain zero and false across language change before one confirmed intent",async({page})=>{
  await page.getByRole("button",{name:"Checking floor and opening dimensions",exact:true}).click();
  await page.getByRole("button",{name:"Start activity",exact:true}).click();await expect(page.getByTestId("intent-count")).toHaveText("0");
  await page.getByRole("textbox",{name:"Count",exact:false}).fill("0");await page.getByRole("combobox",{name:"Ready",exact:false}).selectOption("false");
  // The fixture's outer language control sits behind the modal backdrop.
  await page.getByRole("button",{name:"Change language",exact:true}).evaluate(button=>(button as HTMLButtonElement).click());
  await expect(page.getByRole("textbox",{name:"Cantidad",exact:false})).toHaveValue("0");await expect(page.getByRole("combobox",{name:"Listo",exact:false})).toHaveValue("false");
  await page.setViewportSize({width:320,height:720});await fits(page);
  await page.screenshot({path:test.info().outputPath("es-answers-320.png"),fullPage:true});
  await page.getByRole("button",{name:"Iniciar actividad",exact:true}).click();
  await expect(page.getByTestId("intent-count")).toHaveText("1");const intents=JSON.parse(await page.getByTestId("intent-json").innerText());expect(intents[0].values).toEqual({count:0,ready:false});
});
